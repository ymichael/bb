import { asc, eq } from "drizzle-orm";
import { hostDaemonCommands } from "@bb/db";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import { makeWorkspaceStatus } from "@bb/test-helpers";
import { describe, expect, it, vi } from "vitest";
import {
  queueCommandAndWait,
  waitForQueuedCommandResult,
} from "../../src/services/hosts/command-wait.js";
import { runWithDaemonCommandWaitForbidden } from "../../src/services/hosts/command-wait-context.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedHostSession } from "../helpers/seed.js";

type ThreadStopCommand = Extract<HostDaemonCommand, { type: "thread.stop" }>;
type WorkspaceStatusCommand = Extract<
  HostDaemonCommand,
  { type: "workspace.status" }
>;
type TestAppHarness = Awaited<ReturnType<typeof createTestAppHarness>>;

interface BuildThreadStopCommandArgs {
  threadId: string;
}

interface BuildWorkspaceStatusCommandArgs {
  environmentId: string;
  mergeBaseBranch?: string;
  workspacePath: string;
}

interface CountQueuedHostCommandsArgs {
  harness: TestAppHarness;
  hostId: string;
}

interface ListQueuedHostCommandIdsArgs {
  harness: TestAppHarness;
  hostId: string;
}

interface GetCommandIdAtIndexArgs {
  commandIds: readonly string[];
  index: number;
}

interface RecordWorkspaceStatusSuccessArgs {
  commandId: string;
  harness: TestAppHarness;
}

interface RecordWorkspaceStatusFailureArgs {
  commandId: string;
  errorMessage: string;
  harness: TestAppHarness;
}

interface WaitForQueuedHostCommandCountArgs {
  count: number;
  harness: TestAppHarness;
  hostId: string;
}

const WORKSPACE_STATUS_CACHE_EXPIRY_TEST_DELAY_MS = 1_100;

function buildThreadStopCommand(
  args: BuildThreadStopCommandArgs,
): ThreadStopCommand {
  return {
    type: "thread.stop",
    environmentId: "env-command-wait-context",
    threadId: args.threadId,
  };
}

function buildWorkspaceStatusCommand(
  args: BuildWorkspaceStatusCommandArgs,
): WorkspaceStatusCommand {
  return {
    type: "workspace.status",
    environmentId: args.environmentId,
    mergeBaseBranch: args.mergeBaseBranch,
    workspaceContext: {
      workspacePath: args.workspacePath,
      workspaceProvisionType: "managed-worktree",
    },
  };
}

function countQueuedHostCommands({
  harness,
  hostId,
}: CountQueuedHostCommandsArgs): number {
  return harness.db
    .select({ id: hostDaemonCommands.id })
    .from(hostDaemonCommands)
    .where(eq(hostDaemonCommands.hostId, hostId))
    .all().length;
}

function listQueuedHostCommandIds({
  harness,
  hostId,
}: ListQueuedHostCommandIdsArgs): string[] {
  return harness.db
    .select({
      cursor: hostDaemonCommands.cursor,
      id: hostDaemonCommands.id,
    })
    .from(hostDaemonCommands)
    .where(eq(hostDaemonCommands.hostId, hostId))
    .orderBy(asc(hostDaemonCommands.cursor))
    .all()
    .map((command) => command.id);
}

function getCommandIdAtIndex({
  commandIds,
  index,
}: GetCommandIdAtIndexArgs): string {
  const commandId = commandIds[index];
  if (!commandId) {
    throw new Error(`Expected queued command at index ${index}`);
  }
  return commandId;
}

function recordWorkspaceStatusSuccess({
  commandId,
  harness,
}: RecordWorkspaceStatusSuccessArgs) {
  const result = { workspaceStatus: makeWorkspaceStatus() };
  harness.hub.recordCommandResult(commandId, {
    commandId,
    ok: true,
    result,
    type: "workspace.status",
  });
  return result;
}

function recordWorkspaceStatusFailure({
  commandId,
  errorMessage,
  harness,
}: RecordWorkspaceStatusFailureArgs): void {
  harness.hub.recordCommandResult(commandId, {
    commandId,
    errorCode: "command_failed",
    errorMessage,
    ok: false,
    type: "workspace.status",
  });
}

async function waitForQueuedHostCommandCount({
  count,
  harness,
  hostId,
}: WaitForQueuedHostCommandCountArgs): Promise<void> {
  await vi.waitFor(() => {
    expect(countQueuedHostCommands({ harness, hostId })).toBe(count);
  });
}

async function waitForWorkspaceStatusCacheExpiry(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, WORKSPACE_STATUS_CACHE_EXPIRY_TEST_DELAY_MS);
  });
}

describe("daemon command wait context", () => {
  it("rejects queue-and-wait inside a forbidden daemon-ingress context before queueing", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-command-wait-forbidden",
      });

      await expect(
        runWithDaemonCommandWaitForbidden({
          reason: "test daemon ingress",
          work: () =>
            queueCommandAndWait(harness.deps, {
              command: buildThreadStopCommand({ threadId: "thread-1" }),
              hostId: host.id,
              timeoutMs: 1_000,
            }),
        }),
      ).rejects.toThrow(
        "Daemon command queue-and-wait for thread.stop is forbidden in test daemon ingress",
      );

      const queuedCommands = harness.db
        .select({ id: hostDaemonCommands.id })
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.hostId, host.id))
        .all();
      expect(queuedCommands).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects waiting for an already queued command inside a forbidden daemon-ingress context", async () => {
    const harness = await createTestAppHarness();
    try {
      await expect(
        runWithDaemonCommandWaitForbidden({
          reason: "test command-result ingress",
          work: () =>
            waitForQueuedCommandResult(harness.deps, {
              commandId: "hcmd-forbidden",
              timeoutMs: 1_000,
              type: "thread.stop",
            }),
        }),
      ).rejects.toThrow(
        "Daemon command wait command hcmd-forbidden for thread.stop is forbidden in test command-result ingress",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("allows parallel command waits outside forbidden daemon-ingress contexts", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-command-wait-parallel",
      });

      const waitForResults = Promise.all([
        queueCommandAndWait(harness.deps, {
          command: buildThreadStopCommand({ threadId: "thread-1" }),
          hostId: host.id,
          timeoutMs: 5_000,
        }),
        queueCommandAndWait(harness.deps, {
          command: buildThreadStopCommand({ threadId: "thread-2" }),
          hostId: host.id,
          timeoutMs: 5_000,
        }),
        queueCommandAndWait(harness.deps, {
          command: buildThreadStopCommand({ threadId: "thread-3" }),
          hostId: host.id,
          timeoutMs: 5_000,
        }),
      ]);

      await vi.waitFor(() => {
        const queuedCommands = harness.db
          .select({ id: hostDaemonCommands.id })
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.hostId, host.id))
          .all();
        expect(queuedCommands).toHaveLength(3);
      });

      const queuedCommands = harness.db
        .select({
          cursor: hostDaemonCommands.cursor,
          id: hostDaemonCommands.id,
        })
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.hostId, host.id))
        .orderBy(asc(hostDaemonCommands.cursor))
        .all();
      for (const command of queuedCommands) {
        harness.hub.recordCommandResult(command.id, {
          commandId: command.id,
          ok: true,
          result: {},
          type: "thread.stop",
        });
      }

      await expect(waitForResults).resolves.toEqual([{}, {}, {}]);
    } finally {
      await harness.cleanup();
    }
  });

  it("coalesces identical workspace status waits into one daemon command", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-command-wait-workspace-status",
      });
      const command = buildWorkspaceStatusCommand({
        environmentId: "env-command-wait-workspace-status",
        mergeBaseBranch: "main",
        workspacePath: "/tmp/bb-command-wait-workspace-status",
      });

      const waitForResults = Promise.all([
        queueCommandAndWait(harness.deps, {
          command,
          hostId: host.id,
          timeoutMs: 5_000,
        }),
        queueCommandAndWait(harness.deps, {
          command,
          hostId: host.id,
          timeoutMs: 5_000,
        }),
      ]);

      await vi.waitFor(() => {
        const queuedCommands = harness.db
          .select({ id: hostDaemonCommands.id })
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.hostId, host.id))
          .all();
        expect(queuedCommands).toHaveLength(1);
      });

      const queuedCommand = harness.db
        .select({ id: hostDaemonCommands.id })
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.hostId, host.id))
        .get();
      expect(queuedCommand).toBeDefined();
      if (!queuedCommand) {
        throw new Error("Expected one queued workspace status command");
      }

      const result = { workspaceStatus: makeWorkspaceStatus() };
      harness.hub.recordCommandResult(queuedCommand.id, {
        commandId: queuedCommand.id,
        ok: true,
        result,
        type: "workspace.status",
      });

      await expect(waitForResults).resolves.toEqual([result, result]);
    } finally {
      await harness.cleanup();
    }
  });

  it("queues separate workspace status commands for different cache keys", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-command-wait-workspace-status-keys",
      });
      const firstCommand = buildWorkspaceStatusCommand({
        environmentId: "env-command-wait-workspace-status-key-1",
        mergeBaseBranch: "main",
        workspacePath: "/tmp/bb-command-wait-workspace-status-key-1",
      });
      const secondCommand = buildWorkspaceStatusCommand({
        environmentId: "env-command-wait-workspace-status-key-1",
        mergeBaseBranch: "main",
        workspacePath: "/tmp/bb-command-wait-workspace-status-key-2",
      });

      const waitForResults = Promise.all([
        queueCommandAndWait(harness.deps, {
          command: firstCommand,
          hostId: host.id,
          timeoutMs: 5_000,
        }),
        queueCommandAndWait(harness.deps, {
          command: secondCommand,
          hostId: host.id,
          timeoutMs: 5_000,
        }),
      ]);

      await waitForQueuedHostCommandCount({
        count: 2,
        harness,
        hostId: host.id,
      });
      const commandIds = listQueuedHostCommandIds({
        harness,
        hostId: host.id,
      });
      const firstResult = recordWorkspaceStatusSuccess({
        commandId: getCommandIdAtIndex({ commandIds, index: 0 }),
        harness,
      });
      const secondResult = recordWorkspaceStatusSuccess({
        commandId: getCommandIdAtIndex({ commandIds, index: 1 }),
        harness,
      });

      await expect(waitForResults).resolves.toEqual([
        firstResult,
        secondResult,
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("evicts failed workspace status cache entries before retrying", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-command-wait-workspace-status-failure",
      });
      const command = buildWorkspaceStatusCommand({
        environmentId: "env-command-wait-workspace-status-failure",
        mergeBaseBranch: "main",
        workspacePath: "/tmp/bb-command-wait-workspace-status-failure",
      });

      const failedWait = queueCommandAndWait(harness.deps, {
        command,
        hostId: host.id,
        timeoutMs: 5_000,
      });
      await waitForQueuedHostCommandCount({
        count: 1,
        harness,
        hostId: host.id,
      });
      const firstCommandId = getCommandIdAtIndex({
        commandIds: listQueuedHostCommandIds({ harness, hostId: host.id }),
        index: 0,
      });
      recordWorkspaceStatusFailure({
        commandId: firstCommandId,
        errorMessage: "workspace status failed",
        harness,
      });
      await expect(failedWait).rejects.toThrow("workspace status failed");

      const retryWait = queueCommandAndWait(harness.deps, {
        command,
        hostId: host.id,
        timeoutMs: 5_000,
      });
      await waitForQueuedHostCommandCount({
        count: 2,
        harness,
        hostId: host.id,
      });
      const commandIds = listQueuedHostCommandIds({
        harness,
        hostId: host.id,
      });
      const retryResult = recordWorkspaceStatusSuccess({
        commandId: getCommandIdAtIndex({ commandIds, index: 1 }),
        harness,
      });
      await expect(retryWait).resolves.toEqual(retryResult);
    } finally {
      await harness.cleanup();
    }
  });

  it("evicts timed out workspace status cache entries before retrying", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-command-wait-workspace-status-timeout",
      });
      const command = buildWorkspaceStatusCommand({
        environmentId: "env-command-wait-workspace-status-timeout",
        mergeBaseBranch: "main",
        workspacePath: "/tmp/bb-command-wait-workspace-status-timeout",
      });

      await expect(
        queueCommandAndWait(harness.deps, {
          command,
          hostId: host.id,
          timeoutMs: 1,
        }),
      ).rejects.toThrow("Timed out waiting for command result");

      const retryWait = queueCommandAndWait(harness.deps, {
        command,
        hostId: host.id,
        timeoutMs: 5_000,
      });
      await waitForQueuedHostCommandCount({
        count: 2,
        harness,
        hostId: host.id,
      });
      const commandIds = listQueuedHostCommandIds({
        harness,
        hostId: host.id,
      });
      const retryResult = recordWorkspaceStatusSuccess({
        commandId: getCommandIdAtIndex({ commandIds, index: 1 }),
        harness,
      });
      await expect(retryWait).resolves.toEqual(retryResult);
    } finally {
      await harness.cleanup();
    }
  });

  it("queues a new workspace status command after the cache ttl expires", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-command-wait-workspace-status-ttl",
      });
      const command = buildWorkspaceStatusCommand({
        environmentId: "env-command-wait-workspace-status-ttl",
        mergeBaseBranch: "main",
        workspacePath: "/tmp/bb-command-wait-workspace-status-ttl",
      });

      const firstWait = queueCommandAndWait(harness.deps, {
        command,
        hostId: host.id,
        timeoutMs: 5_000,
      });
      await waitForQueuedHostCommandCount({
        count: 1,
        harness,
        hostId: host.id,
      });
      const firstResult = recordWorkspaceStatusSuccess({
        commandId: getCommandIdAtIndex({
          commandIds: listQueuedHostCommandIds({ harness, hostId: host.id }),
          index: 0,
        }),
        harness,
      });
      await expect(firstWait).resolves.toEqual(firstResult);

      await waitForWorkspaceStatusCacheExpiry();

      const secondWait = queueCommandAndWait(harness.deps, {
        command,
        hostId: host.id,
        timeoutMs: 5_000,
      });
      await waitForQueuedHostCommandCount({
        count: 2,
        harness,
        hostId: host.id,
      });
      const commandIds = listQueuedHostCommandIds({
        harness,
        hostId: host.id,
      });
      const secondResult = recordWorkspaceStatusSuccess({
        commandId: getCommandIdAtIndex({ commandIds, index: 1 }),
        harness,
      });
      await expect(secondWait).resolves.toEqual(secondResult);
    } finally {
      await harness.cleanup();
    }
  });
});

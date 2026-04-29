import { asc, eq } from "drizzle-orm";
import { hostDaemonCommands } from "@bb/db";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import {
  queueCommandAndWait,
  waitForQueuedCommandResult,
} from "../../src/services/hosts/command-wait.js";
import { runWithDaemonCommandWaitForbidden } from "../../src/services/hosts/command-wait-context.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedHostSession } from "../helpers/seed.js";

type ThreadStopCommand = Extract<HostDaemonCommand, { type: "thread.stop" }>;

interface BuildThreadStopCommandArgs {
  threadId: string;
}

function buildThreadStopCommand(
  args: BuildThreadStopCommandArgs,
): ThreadStopCommand {
  return {
    type: "thread.stop",
    environmentId: "env-command-wait-context",
    threadId: args.threadId,
  };
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
});

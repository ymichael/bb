import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  getPendingEnvironmentCommand,
  getHostCommandCursor,
  hasPendingHostCommandForThread,
  fetchCommands,
  queueCommand,
  reportCommandResult,
} from "../../src/data/commands.js";
import { pruneCompletedCommands } from "../../src/data/sweeps.js";
import { upsertHost } from "../../src/data/hosts.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  return { db, host };
}

describe("commands", () => {
  it("assigns monotonic cursors per host", () => {
    const { db, host } = setup();

    const cmd1 = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: "{}",
    });
    const cmd2 = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.diff",
      payload: "{}",
    });
    const cmd3 = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.commit",
      payload: "{}",
    });

    expect(cmd1.cursor).toBe(1);
    expect(cmd2.cursor).toBe(2);
    expect(cmd3.cursor).toBe(3);
  });

  it("assigns independent cursors per host", () => {
    const { db, host } = setup();
    const host2 = upsertHost(db, noopNotifier, {
      name: "test-host-2",
      type: "persistent",
    });

    const cmd1 = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: "{}",
    });
    const cmd2 = queueCommand(db, noopNotifier, {
      hostId: host2.id,
      type: "workspace.status",
      payload: "{}",
    });

    // Each host starts at cursor 1
    expect(cmd1.cursor).toBe(1);
    expect(cmd2.cursor).toBe(1);
  });

  it("keeps cursors monotonic after old terminal commands are pruned", () => {
    const { db, host } = setup();
    const now = Date.now();
    const completedAt = now - 10_000;
    const completedBefore = now - 5_000;

    const cmd1 = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: "{}",
    });
    const cmd2 = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.diff",
      payload: "{}",
    });
    const cmd3 = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.commit",
      payload: "{}",
    });

    for (const command of [cmd1, cmd2, cmd3]) {
      reportCommandResult(db, noopNotifier, {
        commandId: command.id,
        state: "success",
        completedAt,
        resultPayload: JSON.stringify({ ok: true }),
      });
    }

    expect(
      pruneCompletedCommands(db, {
        completedBefore,
        limit: 100,
      }),
    ).toEqual({ deleted: 3 });

    const next = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: "{}",
    });

    expect(next.cursor).toBe(4);
    expect(getHostCommandCursor(db, host.id)).toBe(4);
  });

  it("fetches pending commands and marks as fetched", () => {
    const { db, host } = setup();

    queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: "{}",
    });
    queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.diff",
      payload: "{}",
    });

    const fetched = fetchCommands(db, noopNotifier, { hostId: host.id });
    expect(fetched).toHaveLength(2);
    expect(fetched[0]!.state).toBe("fetched");
    expect(fetched[0]!.fetchedAt).toBeTypeOf("number");

    // Re-fetch should return empty (already fetched)
    const fetched2 = fetchCommands(db, noopNotifier, { hostId: host.id });
    expect(fetched2).toHaveLength(0);
  });

  it("fetches pending commands in cursor order and respects the limit", () => {
    const { db, host } = setup();

    queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: "{}",
    });
    queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.diff",
      payload: "{}",
    });
    queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.commit",
      payload: "{}",
    });

    const fetched = fetchCommands(db, noopNotifier, {
      hostId: host.id,
      limit: 2,
    });
    expect(fetched).toHaveLength(2);
    expect(fetched[0]!.cursor).toBe(1);
    expect(fetched[1]!.cursor).toBe(2);
  });

  it("finds pending commands for a specific thread and command type", () => {
    const { db, host } = setup();

    queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "turn.submit",
      payload: JSON.stringify({
        type: "turn.submit",
        threadId: "thr_target",
      }),
    });
    queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "thread.stop",
      payload: JSON.stringify({
        type: "thread.stop",
        threadId: "thr_other",
      }),
    });

    expect(
      hasPendingHostCommandForThread(db, {
        hostId: host.id,
        threadId: "thr_target",
        type: "turn.submit",
      }),
    ).toBe(true);
    expect(
      hasPendingHostCommandForThread(db, {
        hostId: host.id,
        threadId: "thr_target",
        type: "thread.stop",
      }),
    ).toBe(false);
    expect(
      hasPendingHostCommandForThread(db, {
        hostId: host.id,
        threadId: "thr_missing",
        type: "turn.submit",
      }),
    ).toBe(false);
  });

  it("finds pending environment commands by environment id and type", () => {
    const { db, host } = setup();

    const matching = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: JSON.stringify({
        environmentId: "env_target",
      }),
    });
    queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: JSON.stringify({
        environmentId: "env_other",
      }),
    });

    fetchCommands(db, noopNotifier, { hostId: host.id });

    expect(
      getPendingEnvironmentCommand(db, {
        environmentId: "env_target",
        type: "workspace.status",
      })?.id,
    ).toBe(matching.id);

    reportCommandResult(db, noopNotifier, {
      commandId: matching.id,
      state: "success",
      completedAt: Date.now(),
      resultPayload: JSON.stringify({ ok: true }),
    });

    expect(
      getPendingEnvironmentCommand(db, {
        environmentId: "env_target",
        type: "workspace.status",
      }),
    ).toBeNull();
  });

  it("reports command result", () => {
    const { db, host } = setup();
    const completedAt = 1_700_000_000_000;

    const cmd = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: "{}",
    });

    // Fetch first
    fetchCommands(db, noopNotifier, { hostId: host.id });

    const result = reportCommandResult(db, noopNotifier, {
      commandId: cmd.id,
      state: "success",
      completedAt,
      resultPayload: JSON.stringify({ status: "ok" }),
    });

    expect(result?.state).toBe("success");
    expect(result?.completedAt).toBe(completedAt);
    expect(result?.resultPayload).toBe(JSON.stringify({ status: "ok" }));
  });

  it("reports command error", () => {
    const { db, host } = setup();
    const completedAt = 1_700_000_000_123;

    const cmd = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: "{}",
    });

    fetchCommands(db, noopNotifier, { hostId: host.id });

    const result = reportCommandResult(db, noopNotifier, {
      commandId: cmd.id,
      state: "error",
      completedAt,
      resultPayload: JSON.stringify({ error: "timeout" }),
    });

    expect(result?.state).toBe("error");
    expect(result?.completedAt).toBe(completedAt);
  });
});

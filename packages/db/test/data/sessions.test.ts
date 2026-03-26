import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  openSession,
  closeSession,
  getActiveSession,
  heartbeatSession,
} from "../../src/data/sessions.js";
import { upsertHost } from "../../src/data/hosts.js";
import { hostDaemonSessions } from "../../src/schema.js";
import { eq } from "drizzle-orm";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  return { db, host };
}

describe("sessions", () => {
  it("opens a session and retrieves it", () => {
    const { db, host } = setup();

    const session = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    expect(session.id).toMatch(/^hses_/);
    expect(session.status).toBe("active");
    expect(session.hostId).toBe(host.id);

    const active = getActiveSession(db, host.id);
    expect(active?.id).toBe(session.id);
  });

  it("closes a session", () => {
    const { db, host } = setup();

    const session = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    const closed = closeSession(db, noopNotifier, session.id, "user-requested");
    expect(closed?.status).toBe("closed");
    expect(closed?.closeReason).toBe("user-requested");
    expect(closed?.closedAt).toBeTypeOf("number");

    expect(getActiveSession(db, host.id)).toBeNull();
  });

  it("closes old session when opening new one for same host", () => {
    const { db, host } = setup();

    const session1 = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    const session2 = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-2",
      hostName: "test-host",
      hostType: "persistent",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    expect(session2.id).not.toBe(session1.id);

    // Old session should be closed with reason "replaced"
    const active = getActiveSession(db, host.id);
    expect(active?.id).toBe(session2.id);

    // Verify session1 is closed
    const old = db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, session1.id))
      .get();
    expect(old?.status).toBe("closed");
    expect(old?.closeReason).toBe("replaced");
  });

  it("updates heartbeat timestamps for an active session", () => {
    const { db, host } = setup();
    const session = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    const updated = heartbeatSession(
      db,
      session.id,
      Date.now() + 45_000,
    );
    expect(updated?.lastHeartbeatAt).toBeTypeOf("number");
    expect(updated?.leaseExpiresAt).toBeGreaterThan(Date.now());
  });

  it("does not return expired sessions as active", () => {
    const { db, host } = setup();
    const session = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    db.update(hostDaemonSessions)
      .set({
        leaseExpiresAt: Date.now() - 1,
      })
      .where(eq(hostDaemonSessions.id, session.id))
      .run();

    expect(getActiveSession(db, host.id)).toBeNull();
  });

  it("does not overwrite an already closed session", () => {
    const { db, host } = setup();
    const session = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    closeSession(db, noopNotifier, session.id, "replaced");
    const closedAgain = closeSession(
      db,
      noopNotifier,
      session.id,
      "daemon-disconnect",
    );

    expect(closedAgain?.closeReason).toBe("replaced");
  });
});

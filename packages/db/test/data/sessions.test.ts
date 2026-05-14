import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  closeSession,
  getActiveSession,
  getActiveSessionById,
  getLatestSessionForHost,
  getMostRecentlyUpdatedConnectedHostId,
  heartbeatSession,
  listLatestSessionsForHosts,
  listConnectedHostIds,
  openSession,
} from "../../src/data/sessions.js";
import { getHost, upsertHost } from "../../src/data/hosts.js";
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
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    expect(session.id).toMatch(/^hses_/);
    expect(session.status).toBe("active");
    expect(session.hostId).toBe(host.id);

    const active = getActiveSession(db, host.id);
    expect(active?.id).toBe(session.id);
    expect(getActiveSessionById(db, { sessionId: session.id })?.id).toBe(
      session.id,
    );
  });

  it("marks the host as seen on open, heartbeat, and close", () => {
    const { db, host } = setup();
    expect(getHost(db, host.id)?.lastSeenAt).toBeNull();

    const session = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    const seenAtOpen = getHost(db, host.id)?.lastSeenAt ?? null;
    expect(seenAtOpen).not.toBeNull();

    heartbeatSession(db, session.id, Date.now() + 30_000);
    const seenAtHeartbeat = getHost(db, host.id)?.lastSeenAt ?? null;
    expect(seenAtHeartbeat).not.toBeNull();
    expect(seenAtHeartbeat!).toBeGreaterThanOrEqual(seenAtOpen!);

    closeSession(db, noopNotifier, session.id, "test");
    const seenAtClose = getHost(db, host.id)?.lastSeenAt ?? null;
    expect(seenAtClose).not.toBeNull();
    expect(seenAtClose!).toBeGreaterThanOrEqual(seenAtHeartbeat!);
  });

  it("closes a session", () => {
    const { db, host } = setup();

    const session = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
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
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    const session2 = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-2",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
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

  it("lists the latest session for each requested host", () => {
    const { db, host } = setup();
    const otherHost = upsertHost(db, noopNotifier, {
      name: "test-host-2",
      type: "persistent",
    });

    const firstSession = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    const latestSession = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-2",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    const otherFirstSession = openSession(db, noopNotifier, {
      hostId: otherHost.id,
      instanceId: "inst-3",
      hostName: "test-host-2",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data-2",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    const otherLatestSession = openSession(db, noopNotifier, {
      hostId: otherHost.id,
      instanceId: "inst-4",
      hostName: "test-host-2",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data-2",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    for (const sessionUpdate of [
      { sessionId: firstSession.id, updatedAt: 10 },
      { sessionId: latestSession.id, updatedAt: 20 },
      { sessionId: otherFirstSession.id, updatedAt: 30 },
      { sessionId: otherLatestSession.id, updatedAt: 40 },
    ]) {
      db.update(hostDaemonSessions)
        .set({
          createdAt: sessionUpdate.updatedAt,
          updatedAt: sessionUpdate.updatedAt,
        })
        .where(eq(hostDaemonSessions.id, sessionUpdate.sessionId))
        .run();
    }

    const sessions = listLatestSessionsForHosts(db, {
      hostIds: [host.id, host.id, otherHost.id, "host-missing"],
    });

    expect(sessions.map((session) => session.id).sort()).toEqual(
      [latestSession.id, otherLatestSession.id].sort(),
    );
  });

  it("prefers an active replacement session when latest timestamps tie", () => {
    const { db, host } = setup();
    const closedSession = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    const activeSession = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-2",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    db.update(hostDaemonSessions)
      .set({
        id: "hses_z_closed",
        createdAt: 100,
        updatedAt: 100,
      })
      .where(eq(hostDaemonSessions.id, closedSession.id))
      .run();
    db.update(hostDaemonSessions)
      .set({
        id: "hses_a_active",
        createdAt: 100,
        updatedAt: 100,
      })
      .where(eq(hostDaemonSessions.id, activeSession.id))
      .run();

    expect(getLatestSessionForHost(db, { hostId: host.id })?.id).toBe(
      "hses_a_active",
    );
    expect(
      listLatestSessionsForHosts(db, { hostIds: [host.id] }).map(
        (session) => session.id,
      ),
    ).toEqual(["hses_a_active"]);
  });

  it("updates heartbeat timestamps for an active session", () => {
    const { db, host } = setup();
    const session = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    const updated = heartbeatSession(db, session.id, Date.now() + 45_000);
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
      dataDir: "/tmp/test-host-data",
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
    expect(getActiveSessionById(db, { sessionId: session.id })).toBeNull();
  });

  it("lists connected hosts and returns the most recently updated connected host", () => {
    const { db, host } = setup();
    const otherHost = upsertHost(db, noopNotifier, {
      name: "test-host-2",
      type: "persistent",
    });
    const firstSession = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    openSession(db, noopNotifier, {
      hostId: otherHost.id,
      instanceId: "inst-2",
      hostName: "test-host-2",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data-2",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    closeSession(db, noopNotifier, firstSession.id, "replaced");

    expect(listConnectedHostIds(db)).toEqual([otherHost.id]);
    expect(getMostRecentlyUpdatedConnectedHostId(db)).toBe(otherHost.id);
  });

  it("can restrict the most recently updated connected host by host type", () => {
    const { db, host } = setup();
    const sandboxHost = upsertHost(db, noopNotifier, {
      name: "sandbox-host",
      type: "ephemeral",
    });

    openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-persistent",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    const sandboxSession = openSession(db, noopNotifier, {
      hostId: sandboxHost.id,
      instanceId: "inst-sandbox",
      hostName: "sandbox-host",
      hostType: "ephemeral",
      dataDir: "/tmp/test-sandbox-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    db.update(hostDaemonSessions)
      .set({ updatedAt: sandboxSession.updatedAt + 1_000 })
      .where(eq(hostDaemonSessions.id, sandboxSession.id))
      .run();

    expect(getMostRecentlyUpdatedConnectedHostId(db)).toBe(sandboxHost.id);
    expect(
      getMostRecentlyUpdatedConnectedHostId(db, { hostType: "persistent" }),
    ).toBe(host.id);
  });

  it("does not overwrite an already closed session", () => {
    const { db, host } = setup();
    const session = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
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

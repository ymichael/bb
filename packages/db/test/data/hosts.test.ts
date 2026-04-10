import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  deleteHost,
  getHost,
  getNonDestroyedHost,
  listHosts,
  listNonDestroyedHostsByIds,
  listPublicHosts,
  updateHost,
  upsertHost,
} from "../../src/data/hosts.js";
import {
  markEphemeralHostActivity,
  markHostSuspended,
} from "../../src/data/host-lifecycle-state.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  return { db };
}

describe("hosts", () => {
  it("upsert creates a new host", () => {
    const { db } = setup();
    const host = upsertHost(db, noopNotifier, {
      name: "My Machine",
      type: "persistent",
    });

    expect(host.id).toMatch(/^host_/);
    expect(host.name).toBe("My Machine");
    expect(host.type).toBe("persistent");
    expect(host.lastSeenAt).toBeTypeOf("number");
  });

  it("upsert with same ID updates lastSeenAt", () => {
    const { db } = setup();
    const host1 = upsertHost(db, noopNotifier, {
      name: "My Machine",
      type: "persistent",
    });

    // Wait a tiny bit to ensure different timestamp
    const firstSeen = host1.lastSeenAt;

    const host2 = upsertHost(db, noopNotifier, {
      id: host1.id,
      name: "Updated Name",
      type: "persistent",
    });

    expect(host2.id).toBe(host1.id);
    expect(host2.name).toBe("Updated Name");
    expect(host2.lastSeenAt).toBeGreaterThanOrEqual(firstSeen);
  });

  it("preserves provider, externalId, and destroyedAt when omitted on update", () => {
    const { db } = setup();
    const host = upsertHost(db, noopNotifier, {
      destroyedAt: 123,
      externalId: "sandbox-existing",
      name: "Sandbox Host",
      provider: "e2b",
      type: "ephemeral",
    });

    const updated = upsertHost(db, noopNotifier, {
      id: host.id,
      name: "Sandbox Host Reconnected",
      type: "ephemeral",
    });

    expect(updated).toMatchObject({
      destroyedAt: 123,
      id: host.id,
      name: "Sandbox Host Reconnected",
      provider: "e2b",
      externalId: "sandbox-existing",
      type: "ephemeral",
    });
  });

  it("notifies when upsertHost updates connection state", () => {
    const { db } = setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyCommand() {},
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = upsertHost(db, notifier, {
      destroyedAt: 123,
      name: "Sandbox Host",
      provider: "e2b",
      type: "ephemeral",
    });
    notifyHost.mockClear();

    upsertHost(db, notifier, {
      destroyedAt: null,
      externalId: "sandbox-existing",
      id: host.id,
      name: "Sandbox Host",
      provider: "e2b",
      type: "ephemeral",
    });

    expect(notifyHost).toHaveBeenCalledWith(host.id, ["host-connected"]);
  });

  it("does not notify when upsertHost changes metadata without a connection-state change", () => {
    const { db } = setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyCommand() {},
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = upsertHost(db, notifier, {
      externalId: "sandbox-existing",
      name: "Sandbox Host",
      provider: "e2b",
      type: "ephemeral",
    });
    notifyHost.mockClear();

    upsertHost(db, notifier, {
      id: host.id,
      name: "Sandbox Host Renamed",
      type: "ephemeral",
    });

    expect(notifyHost).not.toHaveBeenCalled();
  });

  it("retrieves a host by ID", () => {
    const { db } = setup();
    const host = upsertHost(db, noopNotifier, {
      name: "My Machine",
      type: "persistent",
    });

    const fetched = getHost(db, host.id);
    expect(fetched?.id).toBe(host.id);
    expect(getHost(db, "host_nonexistent")).toBeNull();
  });

  it("lists all hosts", () => {
    const { db } = setup();
    upsertHost(db, noopNotifier, { name: "Host 1", type: "persistent" });
    upsertHost(db, noopNotifier, { name: "Host 2", type: "ephemeral" });

    const all = listHosts(db);
    expect(all).toHaveLength(2);
  });

  it("lists only persistent non-destroyed hosts for the public inventory", () => {
    const { db } = setup();
    const visibleHost = upsertHost(db, noopNotifier, {
      id: "host-visible",
      name: "Visible Host",
      type: "persistent",
    });
    const destroyedHost = upsertHost(db, noopNotifier, {
      id: "host-destroyed",
      name: "Destroyed Host",
      type: "persistent",
    });
    upsertHost(db, noopNotifier, {
      id: "host-ephemeral",
      name: "Ephemeral Host",
      type: "ephemeral",
    });

    updateHost(db, noopNotifier, destroyedHost.id, { destroyedAt: 123 });

    expect(listPublicHosts(db).map((host) => host.id)).toEqual([visibleHost.id]);
  });

  it("filters destroyed hosts from non-destroyed lookups", () => {
    const { db } = setup();
    const visibleHost = upsertHost(db, noopNotifier, {
      id: "host-visible",
      name: "Visible Host",
      type: "persistent",
    });
    const destroyedHost = upsertHost(db, noopNotifier, {
      id: "host-destroyed",
      name: "Destroyed Host",
      type: "persistent",
    });

    updateHost(db, noopNotifier, destroyedHost.id, { destroyedAt: 123 });

    expect(getNonDestroyedHost(db, visibleHost.id)?.id).toBe(visibleHost.id);
    expect(getNonDestroyedHost(db, destroyedHost.id)).toBeNull();
    expect(
      listNonDestroyedHostsByIds(db, [visibleHost.id, destroyedHost.id]).map(
        (host) => host.id,
      ),
    ).toEqual([visibleHost.id]);
  });

  it("updates only the provided host fields", () => {
    const { db } = setup();
    const host = upsertHost(db, noopNotifier, {
      externalId: "sandbox-old",
      name: "Sandbox Host",
      provider: "e2b",
      type: "ephemeral",
    });

    const updated = updateHost(db, noopNotifier, host.id, {
      externalId: "sandbox-new",
    });

    expect(updated).toMatchObject({
      id: host.id,
      name: "Sandbox Host",
      provider: "e2b",
      externalId: "sandbox-new",
    });
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(host.updatedAt);
  });

  it("updates lifecycle state without changing lastSeenAt", () => {
    const { db } = setup();
    const host = upsertHost(db, noopNotifier, {
      externalId: "sandbox-old",
      name: "Sandbox Host",
      provider: "e2b",
      type: "ephemeral",
    });

    const withActivity = markEphemeralHostActivity(db, {
      hostId: host.id,
      lastActivityAt: 123,
    });
    const updated = markHostSuspended(db, {
      hostId: host.id,
      suspendedAt: 456,
    });

    expect(withActivity).toMatchObject({
      id: host.id,
      lastActivityAt: 123,
      suspendedAt: null,
    });
    expect(updated).toMatchObject({
      id: host.id,
      lastActivityAt: 123,
      suspendedAt: 456,
    });
    expect(updated?.lastSeenAt).toBe(host.lastSeenAt);
  });

  it("notifies when updateHost changes host connection state", () => {
    const { db } = setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyCommand() {},
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = upsertHost(db, notifier, {
      externalId: "sandbox-old",
      name: "Sandbox Host",
      provider: "e2b",
      type: "ephemeral",
    });
    notifyHost.mockClear();

    updateHost(db, notifier, host.id, {
      destroyedAt: 456,
    });

    expect(notifyHost).toHaveBeenCalledWith(host.id, ["host-disconnected"]);
    expect(getHost(db, host.id)).toMatchObject({
      destroyedAt: 456,
      externalId: "sandbox-old",
    });
  });

  it("does not notify when updateHost only changes host metadata", () => {
    const { db } = setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyCommand() {},
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = upsertHost(db, notifier, {
      externalId: "sandbox-old",
      name: "Sandbox Host",
      provider: "e2b",
      type: "ephemeral",
    });
    notifyHost.mockClear();

    updateHost(db, notifier, host.id, {
      name: "Sandbox Host Renamed",
    });

    expect(notifyHost).not.toHaveBeenCalled();
  });

  it("deletes an existing host row", () => {
    const { db } = setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyCommand() {},
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = upsertHost(db, notifier, {
      name: "Transient Host",
      type: "ephemeral",
    });
    notifyHost.mockClear();

    expect(deleteHost(db, notifier, host.id)).toBe(true);
    expect(getHost(db, host.id)).toBeNull();
    expect(notifyHost).toHaveBeenCalledWith(host.id, ["host-disconnected"]);
  });
});

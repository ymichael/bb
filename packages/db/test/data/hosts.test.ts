import { describe, expect, it, vi } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import {
  deleteHost,
  getHost,
  getNonDestroyedHost,
  listHosts,
  listNonDestroyedHostsByIds,
  listPublicHosts,
  markHostSeen,
  updateHost,
  upsertHost,
} from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  return { db };
}

describe("hosts", () => {
  it("upsert creates a new host", () => {
    const { db } = setup();
    const host = upsertHost(db, noopNotifier, {
      name: "My Machine",
    });

    expect(host.id).toMatch(/^host_/);
    expect(host.name).toBe("My Machine");
    expect(host.machineProviderId).toBeNull();
    expect(host.lastSeenAt).toBeNull();
  });

  it("upsert with same ID preserves the display name and lastSeenAt", () => {
    const { db } = setup();
    const host1 = upsertHost(db, noopNotifier, {
      connectMachineId: "machine-1",
      name: "My Machine",
    });

    markHostSeen(db, host1.id, 1_000);

    const host2 = upsertHost(db, noopNotifier, {
      connectMachineId: "machine-2",
      id: host1.id,
      name: "Updated Reported Name",
    });

    expect(host2.id).toBe(host1.id);
    expect(host2.name).toBe("My Machine");
    expect(host2.connectMachineId).toBe("machine-2");
    expect(host2.lastSeenAt).toBe(1_000);
  });

  it("preserves destroyedAt when omitted on update", () => {
    const { db } = setup();
    const host = upsertHost(db, noopNotifier, {
      destroyedAt: 123,
      name: "Disconnected Host",
    });

    const updated = upsertHost(db, noopNotifier, {
      id: host.id,
      name: "Disconnected Host Renamed",
    });

    expect(updated).toMatchObject({
      destroyedAt: 123,
      id: host.id,
      name: "Disconnected Host",
    });
  });

  it("notifies when upsertHost updates connection state", () => {
    const { db } = setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = upsertHost(db, notifier, {
      destroyedAt: 123,
      name: "Persistent Host",
    });
    notifyHost.mockClear();

    upsertHost(db, notifier, {
      destroyedAt: null,
      id: host.id,
      name: "Persistent Host",
    });

    expect(notifyHost).toHaveBeenCalledWith(host.id, ["host-connected"]);
  });

  it("does not notify when upsertHost changes metadata without a connection-state change", () => {
    const { db } = setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = upsertHost(db, notifier, {
      name: "Persistent Host",
    });
    notifyHost.mockClear();

    upsertHost(db, notifier, {
      id: host.id,
      name: "Persistent Host Renamed",
    });

    expect(notifyHost).not.toHaveBeenCalled();
  });

  it("retrieves a host by ID", () => {
    const { db } = setup();
    const host = upsertHost(db, noopNotifier, {
      name: "My Machine",
    });

    const fetched = getHost(db, host.id);
    expect(fetched?.id).toBe(host.id);
    expect(getHost(db, "host_nonexistent")).toBeNull();
  });

  it("lists all hosts", () => {
    const { db } = setup();
    upsertHost(db, noopNotifier, { name: "Host 1" });
    upsertHost(db, noopNotifier, { name: "Host 2" });

    const all = listHosts(db);
    expect(all).toHaveLength(2);
  });

  it("lists only non-destroyed hosts for the public inventory", () => {
    const { db } = setup();
    const visibleHost = upsertHost(db, noopNotifier, {
      id: "host-visible",
      name: "Visible Host",
    });
    const ephemeralHost = upsertHost(db, noopNotifier, {
      id: "host-ephemeral",
      name: "Ephemeral Host",
    });
    const destroyedHost = upsertHost(db, noopNotifier, {
      id: "host-destroyed",
      name: "Destroyed Host",
    });
    updateHost(db, noopNotifier, destroyedHost.id, { destroyedAt: 123 });

    expect(listPublicHosts(db).map((host) => host.id)).toEqual([
      visibleHost.id,
      ephemeralHost.id,
    ]);
  });

  it("filters destroyed hosts from non-destroyed lookups", () => {
    const { db } = setup();
    const visibleHost = upsertHost(db, noopNotifier, {
      id: "host-visible",
      name: "Visible Host",
    });
    const destroyedHost = upsertHost(db, noopNotifier, {
      id: "host-destroyed",
      name: "Destroyed Host",
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
      name: "Persistent Host",
    });

    const updated = updateHost(db, noopNotifier, host.id, {
      name: "Persistent Host Renamed",
    });

    expect(updated).toMatchObject({
      id: host.id,
      name: "Persistent Host Renamed",
    });
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(host.updatedAt);
  });

  it("notifies when updateHost changes host connection state", () => {
    const { db } = setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = upsertHost(db, notifier, {
      name: "Persistent Host",
    });
    notifyHost.mockClear();

    updateHost(db, notifier, host.id, {
      destroyedAt: 456,
    });

    expect(notifyHost).toHaveBeenCalledWith(host.id, ["host-disconnected"]);
    expect(getHost(db, host.id)).toMatchObject({
      destroyedAt: 456,
    });
  });

  it("does not notify when updateHost only changes host metadata", () => {
    const { db } = setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = upsertHost(db, notifier, {
      name: "Persistent Host",
    });
    notifyHost.mockClear();

    updateHost(db, notifier, host.id, {
      name: "Persistent Host Renamed",
    });

    expect(notifyHost).not.toHaveBeenCalled();
  });

  it("deletes an existing host row", () => {
    const { db } = setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = upsertHost(db, notifier, {
      name: "Transient Host",
    });
    notifyHost.mockClear();

    expect(deleteHost(db, notifier, host.id)).toBe(true);
    expect(getHost(db, host.id)).toBeNull();
    expect(notifyHost).toHaveBeenCalledWith(host.id, ["host-disconnected"]);
  });
});

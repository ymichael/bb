import {
  createConnection,
  heartbeatSession,
  migrate,
  noopNotifier,
  openSession,
  updateHost,
  upsertHost,
} from "@bb/db";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonServerWsMessageSchema,
  hostDaemonSessionOpenResponseSchema,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import { HostSharedPortCoordinator } from "../../src/ws/host-shared-ports.js";
import { NotificationHub } from "../../src/ws/hub.js";
import {
  onDaemonSocketMessage,
  onDaemonSocketOpen,
} from "../../src/ws/daemon-protocol.js";
import { readJson } from "../helpers/json.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import {
  createTestDaemonHostKey,
  withTestHarness,
} from "../helpers/test-app.js";

function setup(args: { enrolled?: boolean; online?: boolean } = {}) {
  const db = createConnection(":memory:");
  migrate(db);
  const hub = new NotificationHub();
  const sharedPorts = new HostSharedPortCoordinator({ db, hub });
  const host = upsertHost(db, noopNotifier, {
    id: "host-1",
    name: "test-host",
    type: "persistent",
    ...(args.enrolled === false ? {} : { connectMachineId: "machine-1" }),
  });
  if (args.enrolled !== false && args.online !== false) {
    const session = openSession(db, {
      hostId: host.id,
      instanceId: "instance-1",
      hostName: host.name,
      hostType: host.type,
      dataDir: "/tmp/host-data",
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      heartbeatIntervalMs: 30_000,
      leaseTimeoutMs: 90_000,
    });
    sharedPorts.recordHostConnectCapability({
      hostId: host.id,
      sessionId: session.id,
      hasMachineCredential: true,
    });
    return { db, host, hub, session, sharedPorts };
  }
  return { db, host, hub, session: null, sharedPorts };
}

describe("HostSharedPortCoordinator", () => {
  it("aggregates owner replacements and pushes only changed desired sets", () => {
    const { host, hub, session, sharedPorts } = setup();
    const daemonSocket = createMockHubSocket();
    if (!session) {
      throw new Error("expected an enrolled setup session");
    }
    hub.registerDaemon(session.id, host.id, daemonSocket);

    expect(sharedPorts.reconcileSharedPortsForHost(host.id)).toEqual({
      generation: 0,
      ports: [],
    });

    sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [8080, 3000, 8080],
    });
    const first = sharedPorts.reconcileSharedPortsForHost(host.id);
    expect(first).toEqual({ generation: 1, ports: [3000, 8080] });
    expect(
      hostDaemonServerWsMessageSchema.parse(
        JSON.parse(daemonSocket.messages[0]!),
      ),
    ).toEqual({ type: "connect-shares.replace", ...first });

    sharedPorts.declareSharedPorts({
      ownerId: "other-plugin",
      hostId: host.id,
      ports: [4173],
    });
    sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [8080],
    });
    const replacement = sharedPorts.reconcileSharedPortsForHost(host.id);
    expect(replacement).toEqual({ generation: 3, ports: [4173, 8080] });

    sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [8080],
    });
    expect(sharedPorts.reconcileSharedPortsForHost(host.id)).toEqual(
      replacement,
    );
    expect(daemonSocket.messages).toHaveLength(3);

    sharedPorts.clearDeclarationsForOwner("connect");
    expect(sharedPorts.reconcileSharedPortsForHost(host.id)).toEqual({
      generation: 4,
      ports: [4173],
    });
  });

  it("replaces one owner's complete declaration set only after validation", () => {
    const { host, sharedPorts } = setup();
    sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [3000],
    });

    expect(() =>
      sharedPorts.replaceDeclarationsForOwner("connect", [
        { hostId: host.id, ports: [4173] },
        { hostId: "missing-host", ports: [8080] },
      ]),
    ).toThrow(/unknown host missing-host/);
    expect(sharedPorts.reconcileSharedPortsForHost(host.id).ports).toEqual([
      3000,
    ]);

    sharedPorts.replaceDeclarationsForOwner("connect", [
      { hostId: host.id, ports: [4173] },
    ]);
    expect(sharedPorts.reconcileSharedPortsForHost(host.id).ports).toEqual([
      4173,
    ]);
  });

  it("delivers changed ports over a registered credentialed socket after its lease stales", () => {
    const { db, host, hub, session, sharedPorts } = setup();
    if (!session) throw new Error("expected an online host session");
    const daemonSocket = createMockHubSocket();
    hub.registerDaemon(session.id, host.id, daemonSocket);

    sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [3000],
    });
    heartbeatSession(db, session.id, Date.now() - 1);
    sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [],
    });

    expect(daemonSocket.messages.map((message) => JSON.parse(message))).toEqual(
      [
        {
          type: "connect-shares.replace",
          generation: 1,
          ports: [3000],
        },
        {
          type: "connect-shares.replace",
          generation: 2,
          ports: [],
        },
      ],
    );
  });

  it("rejects a registered credentialless session after its lease stales", () => {
    const { db, host, hub, session, sharedPorts } = setup();
    if (!session) throw new Error("expected an online host session");
    hub.registerDaemon(session.id, host.id, createMockHubSocket());
    sharedPorts.recordHostConnectCapability({
      hostId: host.id,
      sessionId: session.id,
      hasMachineCredential: false,
    });
    heartbeatSession(db, session.id, Date.now() - 1);

    let declarationError: unknown;
    try {
      sharedPorts.declareSharedPorts({
        ownerId: "connect",
        hostId: host.id,
        ports: [3000],
      });
    } catch (error) {
      declarationError = error;
    }

    expect(declarationError).toBeInstanceOf(ApiError);
    expect(declarationError).toMatchObject({
      body: { code: "connect_host_unenrolled" },
    });
    expect(sharedPorts.reconcileSharedPortsForHost(host.id)).toEqual({
      generation: 0,
      ports: [],
    });
  });

  it("retains changed generations through a full disconnect and reconnect", () => {
    const { db, host, hub, session, sharedPorts } = setup();
    if (!session) throw new Error("expected an online host session");
    const firstSocket = createMockHubSocket();
    hub.registerDaemon(session.id, host.id, firstSocket);
    sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [3000],
    });

    hub.unregisterDaemon(session.id);
    sharedPorts.clearHostConnectCapability(session.id);
    sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [4173],
    });
    expect(firstSocket.messages.map((message) => JSON.parse(message))).toEqual([
      {
        type: "connect-shares.replace",
        generation: 1,
        ports: [3000],
      },
    ]);

    const reconnected = openSession(db, {
      hostId: host.id,
      instanceId: "reconnected-instance",
      hostName: host.name,
      hostType: host.type,
      dataDir: "/tmp/host-data",
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      heartbeatIntervalMs: 30_000,
      leaseTimeoutMs: 90_000,
    });
    sharedPorts.recordHostConnectCapability({
      hostId: host.id,
      sessionId: reconnected.id,
      hasMachineCredential: true,
    });
    const secondSocket = createMockHubSocket();
    hub.registerDaemon(reconnected.id, host.id, secondSocket);

    expect(sharedPorts.pushCurrentSharedPortsForHost(host.id)).toEqual({
      generation: 2,
      ports: [4173],
    });
    expect(secondSocket.messages.map((message) => JSON.parse(message))).toEqual(
      [
        {
          type: "connect-shares.replace",
          generation: 2,
          ports: [4173],
        },
      ],
    );
  });

  it("retains declarations for offline enrolled hosts and delivers them on reconnect", () => {
    const { sharedPorts } = setup();
    expect(() =>
      sharedPorts.declareSharedPorts({
        ownerId: "connect",
        hostId: "missing-host",
        ports: [3000],
      }),
    ).toThrow(/unknown host missing-host/);

    const credentialless = setup({ enrolled: false });
    let unenrolledError: unknown;
    try {
      credentialless.sharedPorts.declareSharedPorts({
        ownerId: "connect",
        hostId: credentialless.host.id,
        ports: [3000],
      });
    } catch (error) {
      unenrolledError = error;
    }
    expect(unenrolledError).toBeInstanceOf(ApiError);
    expect(unenrolledError).toMatchObject({
      body: {
        code: "connect_host_unenrolled",
        message: expect.stringContaining("enroll it via Connect"),
      },
    });

    const offline = setup({ online: false });
    expect(() =>
      offline.sharedPorts.declareSharedPorts({
        ownerId: "connect",
        hostId: offline.host.id,
        ports: [3000],
      }),
    ).not.toThrow();

    const session = openSession(offline.db, {
      hostId: offline.host.id,
      instanceId: "reconnected-instance",
      hostName: offline.host.name,
      hostType: offline.host.type,
      dataDir: "/tmp/host-data",
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      heartbeatIntervalMs: 30_000,
      leaseTimeoutMs: 90_000,
    });
    offline.sharedPorts.recordHostConnectCapability({
      hostId: offline.host.id,
      sessionId: session.id,
      hasMachineCredential: true,
    });
    const daemonSocket = createMockHubSocket();
    offline.hub.registerDaemon(session.id, offline.host.id, daemonSocket);

    expect(
      offline.sharedPorts.pushCurrentSharedPortsForHost(offline.host.id),
    ).toEqual({ generation: 1, ports: [3000] });
    expect(daemonSocket.messages.map((message) => JSON.parse(message))).toEqual(
      [
        {
          type: "connect-shares.replace",
          generation: 1,
          ports: [3000],
        },
      ],
    );
  });

  it("always accepts empty declarations for offline, unenrolled, and removed hosts", () => {
    const offline = setup();
    if (!offline.session) throw new Error("expected an online host session");
    offline.sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: offline.host.id,
      ports: [3000],
    });
    offline.sharedPorts.clearHostConnectCapability(offline.session.id);
    offline.sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: offline.host.id,
      ports: [],
    });
    expect(
      offline.sharedPorts.reconcileSharedPortsForHost(offline.host.id),
    ).toEqual({ generation: 2, ports: [] });

    const unenrolled = setup({ enrolled: false });
    unenrolled.sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: unenrolled.host.id,
      ports: [],
    });
    expect(
      unenrolled.sharedPorts.reconcileSharedPortsForHost(unenrolled.host.id),
    ).toEqual({ generation: 0, ports: [] });

    const removed = setup();
    removed.sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: removed.host.id,
      ports: [4000],
    });
    updateHost(removed.db, noopNotifier, removed.host.id, {
      destroyedAt: Date.now(),
    });
    removed.sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: removed.host.id,
      ports: [],
    });
    expect(
      removed.sharedPorts.reconcileSharedPortsForHost(removed.host.id),
    ).toEqual({ generation: 2, ports: [] });

    removed.sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: "missing-host",
      ports: [],
    });
    expect(
      removed.sharedPorts.reconcileSharedPortsForHost("missing-host"),
    ).toEqual({ generation: 0, ports: [] });
  });

  it("stores only daemon-reported tunnel identity", () => {
    const { host, sharedPorts } = setup();
    expect(sharedPorts.getTunnelIdentity(host.id)).toBeNull();
    expect(
      sharedPorts.recordTunnelIdentity(host.id, {
        label: "sawyer-air",
        baseDomain: "getbb.app",
      }),
    ).toEqual({ label: "sawyer-air", baseDomain: "getbb.app" });
    expect(sharedPorts.getTunnelIdentity(host.id)).toEqual({
      label: "sawyer-air",
      baseDomain: "getbb.app",
    });
  });
});

describe("daemon session connect shares", () => {
  it("includes the current authoritative set in the session-open response", async () => {
    await withTestHarness(async (harness) => {
      upsertHost(harness.db, harness.hub, {
        id: "host-1",
        name: "Host",
        type: "persistent",
        connectMachineId: "machine-1",
      });
      const previousSession = openSession(harness.db, {
        hostId: "host-1",
        instanceId: "previous-instance",
        hostName: "Host",
        hostType: "persistent",
        dataDir: "/tmp/host-data",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        heartbeatIntervalMs: 30_000,
        leaseTimeoutMs: 90_000,
      });
      harness.deps.sharedPorts.recordHostConnectCapability({
        hostId: "host-1",
        sessionId: previousSession.id,
        hasMachineCredential: true,
      });
      harness.deps.sharedPorts.declareSharedPorts({
        ownerId: "connect",
        hostId: "host-1",
        ports: [4173],
      });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: {
          authorization: `Bearer ${createTestDaemonHostKey({ hostId: "host-1" })}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host-1",
          instanceId: "instance-1",
          hostName: "Host",
          hostType: "persistent",
          hasMachineCredential: true,
          platform: "darwin",
          dataDir: "/tmp/host-data",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      await expect(readJson(response)).resolves.toMatchObject({
        connectShares: { generation: 1, ports: [4173] },
      });
    });
  });

  it("reconciles a declaration made after HTTP open but before WebSocket registration", async () => {
    await withTestHarness(async (harness) => {
      upsertHost(harness.db, harness.hub, {
        id: "host-1",
        name: "Host",
        type: "persistent",
        connectMachineId: "machine-1",
      });
      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: {
          authorization: `Bearer ${createTestDaemonHostKey({ hostId: "host-1" })}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host-1",
          instanceId: "instance-1",
          hostName: "Host",
          hostType: "persistent",
          hasMachineCredential: true,
          platform: "darwin",
          dataDir: "/tmp/host-data",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });
      const session = hostDaemonSessionOpenResponseSchema.parse(
        await response.json(),
      );
      expect(session.connectShares).toEqual({ generation: 0, ports: [] });

      harness.deps.sharedPorts.declareSharedPorts({
        ownerId: "connect",
        hostId: "host-1",
        ports: [4173],
      });
      const daemonSocket = createMockHubSocket();
      onDaemonSocketOpen(harness.deps, {
        hostId: "host-1",
        sessionId: session.sessionId,
        socket: daemonSocket,
      });

      expect(
        daemonSocket.messages.map((message) => JSON.parse(message)),
      ).toContainEqual({
        type: "connect-shares.replace",
        generation: 1,
        ports: [4173],
      });

      onDaemonSocketMessage(harness.deps, {
        hostId: "host-1",
        sessionId: session.sessionId,
        socket: daemonSocket,
        raw: JSON.stringify({
          type: "connect-tunnel.identity",
          identity: { label: "sawyer-air", baseDomain: "getbb.app" },
        }),
      });
      expect(harness.deps.sharedPorts.getTunnelIdentity("host-1")).toEqual({
        label: "sawyer-air",
        baseDomain: "getbb.app",
      });
    });
  });

  it("rejects declarations while the current session lacks its machine credential", async () => {
    await withTestHarness(async (harness) => {
      upsertHost(harness.db, harness.hub, {
        id: "host-1",
        name: "Host",
        type: "persistent",
        connectMachineId: "machine-1",
      });
      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: {
          authorization: `Bearer ${createTestDaemonHostKey({ hostId: "host-1" })}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host-1",
          instanceId: "restarted-without-credential",
          hostName: "Host",
          hostType: "persistent",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-data",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });
      expect(response.status).toBe(201);
      const session = hostDaemonSessionOpenResponseSchema.parse(
        await response.json(),
      );
      const daemonSocket = createMockHubSocket();
      onDaemonSocketOpen(harness.deps, {
        hostId: "host-1",
        sessionId: session.sessionId,
        socket: daemonSocket,
      });
      const messagesBeforeDeclaration = [...daemonSocket.messages];

      expect(() =>
        harness.deps.sharedPorts.declareSharedPorts({
          ownerId: "connect",
          hostId: "host-1",
          ports: [4173],
        }),
      ).toThrow(
        'cannot share ports from host "Host" (host-1) because it has no bb connect machine credential; enroll it via Connect in Settings > Machines',
      );
      expect(daemonSocket.messages).toEqual(messagesBeforeDeclaration);
      expect(
        harness.deps.sharedPorts.reconcileSharedPortsForHost("host-1"),
      ).toEqual({ generation: 0, ports: [] });
    });
  });
});

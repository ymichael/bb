import {
  createConnection,
  createEnvironment,
  createProject,
  createThread,
  environments,
  migrate,
  noopNotifier,
  updateThread,
  upsertHost,
} from "@bb/db";
import { eq } from "drizzle-orm";
import {
  hostDaemonServerWsMessageSchema,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { NotificationHub } from "../../src/ws/hub.js";
import { WatchInterestCoordinator } from "../../src/ws/watch-interests.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const hub = new NotificationHub();
  const watchInterests = new WatchInterestCoordinator({ db, hub });
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/test-workspace",
    status: "ready",
  });
  return { db, environment, host, hub, project, watchInterests };
}

function lastDaemonMessage(socket: {
  messages: string[];
}): HostDaemonServerWsMessage {
  const message = socket.messages[socket.messages.length - 1];
  if (!message) {
    throw new Error("Expected daemon message");
  }
  return hostDaemonServerWsMessageSchema.parse(JSON.parse(message));
}

describe("WatchInterestCoordinator", () => {
  it("ref-counts duplicate workspace interests across sockets", () => {
    const { environment, host, hub, watchInterests } = setup();
    const daemonSocket = createMockHubSocket();
    const socketA = createMockHubSocket();
    const socketB = createMockHubSocket();
    hub.registerDaemon("session-1", host.id, daemonSocket);

    watchInterests.subscribe(socketA, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    watchInterests.subscribe(socketB, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    expect(daemonSocket.messages).toHaveLength(1);

    expect(lastDaemonMessage(daemonSocket)).toMatchObject({
      type: "watch-set.replace",
      workspaceTargets: [
        {
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: "/tmp/test-workspace",
          },
        },
      ],
      threadStorageTargets: [],
    });

    watchInterests.unsubscribe(socketA, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    expect(daemonSocket.messages).toHaveLength(1);
    expect(lastDaemonMessage(daemonSocket)).toMatchObject({
      type: "watch-set.replace",
      workspaceTargets: [
        {
          environmentId: environment.id,
        },
      ],
    });

    watchInterests.unsubscribe(socketB, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    expect(daemonSocket.messages).toHaveLength(2);
    expect(lastDaemonMessage(daemonSocket)).toMatchObject({
      type: "watch-set.replace",
      workspaceTargets: [],
      threadStorageTargets: [],
    });
  });

  it("does not create watch targets for list subscriptions", () => {
    const { host, hub, watchInterests } = setup();
    const daemonSocket = createMockHubSocket();
    const socket = createMockHubSocket();
    hub.registerDaemon("session-1", host.id, daemonSocket);

    watchInterests.subscribe(socket, { kind: "environment-list" });
    watchInterests.subscribe(socket, { kind: "thread-list" });

    expect(daemonSocket.messages).toHaveLength(0);
    expect(watchInterests.reconcileWatchSetForHost(host.id)).toEqual({
      generation: 0,
      workspaceTargets: [],
      threadStorageTargets: [],
    });
  });

  it("releases all socket interests on socket close", () => {
    const { environment, host, hub, watchInterests } = setup();
    const daemonSocket = createMockHubSocket();
    const socket = createMockHubSocket();
    hub.registerDaemon("session-1", host.id, daemonSocket);

    watchInterests.subscribe(socket, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    watchInterests.releaseSocket(socket);

    expect(lastDaemonMessage(daemonSocket)).toMatchObject({
      type: "watch-set.replace",
      workspaceTargets: [],
      threadStorageTargets: [],
    });
  });

  it("includes current targets in session-open watch sets", () => {
    const { environment, host, watchInterests } = setup();
    const socket = createMockHubSocket();

    watchInterests.subscribe(socket, {
      kind: "environment-detail",
      environmentId: environment.id,
    });

    expect(watchInterests.reconcileWatchSetForHost(host.id)).toEqual({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: "/tmp/test-workspace",
          },
        },
      ],
      threadStorageTargets: [],
    });
  });

  it("omits unresolved workspace targets from snapshots", () => {
    const { db, host, project, watchInterests } = setup();
    const unready = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/unready",
      status: "provisioning",
    });
    const destroyed = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/destroyed",
      status: "destroyed",
    });
    const socket = createMockHubSocket();

    watchInterests.subscribe(socket, {
      kind: "environment-detail",
      environmentId: unready.id,
    });
    watchInterests.subscribe(socket, {
      kind: "environment-detail",
      environmentId: destroyed.id,
    });

    expect(
      watchInterests.reconcileWatchSetForHost(host.id).workspaceTargets,
    ).toEqual([]);
  });

  it("starts watching when a subscribed environment becomes ready", () => {
    const { db, host, hub, project, watchInterests } = setup();
    const daemonSocket = createMockHubSocket();
    const socket = createMockHubSocket();
    const environment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/later-ready",
      status: "provisioning",
    });
    hub.registerDaemon("session-1", host.id, daemonSocket);

    watchInterests.subscribe(socket, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    expect(daemonSocket.messages).toHaveLength(0);

    db.update(environments)
      .set({ status: "ready" })
      .where(eq(environments.id, environment.id))
      .run();
    hub.notifyEnvironment(environment.id, ["status-changed"]);

    expect(lastDaemonMessage(daemonSocket)).toMatchObject({
      type: "watch-set.replace",
      workspaceTargets: [
        {
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: "/tmp/later-ready",
          },
        },
      ],
      threadStorageTargets: [],
    });
  });

  it("does not replace watch sets for ordinary workspace change events", () => {
    const { environment, host, hub, watchInterests } = setup();
    const daemonSocket = createMockHubSocket();
    const socket = createMockHubSocket();
    hub.registerDaemon("session-1", host.id, daemonSocket);

    watchInterests.subscribe(socket, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    const snapshotCount = daemonSocket.messages.length;

    hub.notifyEnvironment(environment.id, ["work-status-changed"]);

    expect(daemonSocket.messages).toHaveLength(snapshotCount);
  });

  it("does not replace a watch set when a relevant invalidation resolves identically", () => {
    const { environment, host, hub, watchInterests } = setup();
    const daemonSocket = createMockHubSocket();
    const socket = createMockHubSocket();
    hub.registerDaemon("session-1", host.id, daemonSocket);

    watchInterests.subscribe(socket, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    const snapshotCount = daemonSocket.messages.length;

    hub.notifyEnvironment(environment.id, ["metadata-changed"]);

    expect(daemonSocket.messages).toHaveLength(snapshotCount);
  });

  it("resolves thread-detail subscriptions to the owning thread storage target", () => {
    const { db, environment, host, project, watchInterests } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const socket = createMockHubSocket();

    watchInterests.subscribe(socket, {
      kind: "thread-detail",
      threadId: thread.id,
    });

    expect(watchInterests.reconcileWatchSetForHost(host.id)).toMatchObject({
      threadStorageTargets: [
        {
          environmentId: environment.id,
          threadId: thread.id,
        },
      ],
      workspaceTargets: [],
    });
  });

  it("starts watching thread storage after a subscribed thread is attached to an environment", () => {
    const { db, environment, host, hub, project, watchInterests } = setup();
    const daemonSocket = createMockHubSocket();
    const socket = createMockHubSocket();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: null,
      providerId: "codex",
    });
    hub.registerDaemon("session-1", host.id, daemonSocket);

    watchInterests.subscribe(socket, {
      kind: "thread-detail",
      threadId: thread.id,
    });
    expect(daemonSocket.messages).toHaveLength(0);

    updateThread(db, hub, thread.id, {
      environmentId: environment.id,
    });

    expect(lastDaemonMessage(daemonSocket)).toMatchObject({
      type: "watch-set.replace",
      threadStorageTargets: [
        {
          environmentId: environment.id,
          threadId: thread.id,
        },
      ],
      workspaceTargets: [],
    });
  });
});

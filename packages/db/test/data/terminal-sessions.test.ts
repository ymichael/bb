import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  createTerminalSession,
  listTerminalSessionsByThread,
  markDaemonTerminalSessionsDisconnected,
  markEnvironmentTerminalSessionsExited,
  markTerminalSessionRunning,
  markThreadTerminalSessionsExited,
} from "../../src/data/terminal-sessions.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { openSession } from "../../src/data/sessions.js";
import { createThread } from "../../src/data/threads.js";

type TestDb = ReturnType<typeof createConnection>;
type TestHost = ReturnType<typeof upsertHost>;
type TestSession = ReturnType<typeof openSession>;
type TestEnvironment = ReturnType<typeof createEnvironment>;
type TestThread = ReturnType<typeof createThread>;

interface TerminalSessionFixture {
  db: TestDb;
  environment: TestEnvironment;
  host: TestHost;
  session: TestSession;
  thread: TestThread;
}

function openTestSession(db: TestDb, hostId: string): TestSession {
  return openSession(db, noopNotifier, {
    hostId,
    instanceId: "inst-1",
    hostName: "test-host",
    hostType: "persistent",
    dataDir: "/tmp/test-host-data",
    protocolVersion: 1,
    heartbeatIntervalMs: 10_000,
    leaseTimeoutMs: 30_000,
  });
}

function setup(): TerminalSessionFixture {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const session = openTestSession(db, host.id);
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/workspace",
    status: "ready",
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    workspaceProvisionType: "unmanaged",
    branchName: "main",
    baseBranch: null,
    defaultBranch: "main",
    mergeBaseBranch: null,
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: "idle",
  });
  return {
    db,
    environment,
    host,
    session,
    thread,
  };
}

function createStartingTerminal(fixture: TerminalSessionFixture) {
  return createTerminalSession(fixture.db, {
    cols: 80,
    currentCwd: null,
    daemonSessionId: fixture.session.id,
    environmentId: fixture.environment.id,
    hostId: fixture.host.id,
    initialCwd: "/tmp/workspace",
    rows: 24,
    status: "starting",
    threadId: fixture.thread.id,
    title: "Terminal 1",
  });
}

describe("terminal sessions", () => {
  it("marks only the expected starting daemon session running", () => {
    const fixture = setup();
    const terminal = createStartingTerminal(fixture);

    const running = markTerminalSessionRunning(fixture.db, {
      cols: 100,
      currentCwd: null,
      daemonSessionId: fixture.session.id,
      initialCwd: "/tmp/workspace",
      rows: 30,
      terminalId: terminal.id,
      title: "zsh",
    });

    expect(running).toMatchObject({
      id: terminal.id,
      status: "running",
      daemonSessionId: fixture.session.id,
      cols: 100,
      rows: 30,
      title: "zsh",
    });
  });

  it("does not resurrect a terminal exited by thread deletion", () => {
    const fixture = setup();
    const terminal = createStartingTerminal(fixture);
    markThreadTerminalSessionsExited(fixture.db, {
      threadId: fixture.thread.id,
      closeReason: "thread-deleted",
    });

    const running = markTerminalSessionRunning(fixture.db, {
      cols: 100,
      currentCwd: null,
      daemonSessionId: fixture.session.id,
      initialCwd: "/tmp/workspace",
      rows: 30,
      terminalId: terminal.id,
      title: "zsh",
    });

    expect(running).toBeNull();
    expect(listTerminalSessionsByThread(fixture.db, fixture.thread.id)).toEqual([
      expect.objectContaining({
        id: terminal.id,
        closeReason: "thread-deleted",
        daemonSessionId: null,
        status: "exited",
      }),
    ]);
  });

  it("does not resurrect a terminal exited by environment destruction", () => {
    const fixture = setup();
    const terminal = createStartingTerminal(fixture);
    markEnvironmentTerminalSessionsExited(fixture.db, {
      environmentId: fixture.environment.id,
      closeReason: "environment-destroyed",
    });

    const running = markTerminalSessionRunning(fixture.db, {
      cols: 100,
      currentCwd: null,
      daemonSessionId: fixture.session.id,
      initialCwd: "/tmp/workspace",
      rows: 30,
      terminalId: terminal.id,
      title: "zsh",
    });

    expect(running).toBeNull();
    expect(listTerminalSessionsByThread(fixture.db, fixture.thread.id)).toEqual([
      expect.objectContaining({
        id: terminal.id,
        closeReason: "environment-destroyed",
        daemonSessionId: null,
        status: "exited",
      }),
    ]);
  });

  it("does not resurrect a terminal disconnected from its daemon session", () => {
    const fixture = setup();
    const terminal = createStartingTerminal(fixture);
    markDaemonTerminalSessionsDisconnected(fixture.db, {
      daemonSessionId: fixture.session.id,
    });

    const running = markTerminalSessionRunning(fixture.db, {
      cols: 100,
      currentCwd: null,
      daemonSessionId: fixture.session.id,
      initialCwd: "/tmp/workspace",
      rows: 30,
      terminalId: terminal.id,
      title: "zsh",
    });

    expect(running).toBeNull();
    expect(listTerminalSessionsByThread(fixture.db, fixture.thread.id)).toEqual([
      expect.objectContaining({
        id: terminal.id,
        daemonSessionId: null,
        status: "disconnected",
      }),
    ]);
  });

  it("does not mark a starting terminal running for another daemon session", () => {
    const fixture = setup();
    const terminal = createStartingTerminal(fixture);
    const replacementSession = openTestSession(fixture.db, fixture.host.id);

    const running = markTerminalSessionRunning(fixture.db, {
      cols: 100,
      currentCwd: null,
      daemonSessionId: replacementSession.id,
      initialCwd: "/tmp/workspace",
      rows: 30,
      terminalId: terminal.id,
      title: "zsh",
    });

    expect(running).toBeNull();
    expect(listTerminalSessionsByThread(fixture.db, fixture.thread.id)).toEqual([
      expect.objectContaining({
        id: terminal.id,
        daemonSessionId: fixture.session.id,
        status: "starting",
      }),
    ]);
  });
});

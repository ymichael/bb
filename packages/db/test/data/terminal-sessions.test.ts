import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  createTerminalSession,
  getTerminalSession,
  listTerminalSessions,
  updateTerminalSession,
  updateTerminalSessions,
} from "../../src/data/terminal-sessions.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { openSession } from "../../src/data/sessions.js";
import { createThread } from "../../src/data/threads.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

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

function listTerminalSessionsByThread(db: TestDb, threadId: string) {
  return listTerminalSessions(db, {
    scope: { kind: "thread", threadId },
    visible: false,
  });
}

function listVisibleTerminalSessionsByThread(db: TestDb, threadId: string) {
  return listTerminalSessions(db, {
    scope: { kind: "thread", threadId },
    visible: true,
  });
}

function listThreadlessTerminalSessionsByEnvironment(
  db: TestDb,
  environmentId: string,
) {
  return listTerminalSessions(db, {
    scope: { environmentId, kind: "threadless-environment" },
    visible: false,
  });
}

function listVisibleThreadlessTerminalSessionsByEnvironment(
  db: TestDb,
  environmentId: string,
) {
  return listTerminalSessions(db, {
    scope: { environmentId, kind: "threadless-environment" },
    visible: true,
  });
}

function getThreadlessTerminalSessionForEnvironment(
  db: TestDb,
  args: { environmentId: string; terminalId: string },
) {
  return getTerminalSession(db, {
    ...args,
    kind: "threadless-environment",
  });
}

function markThreadlessTerminalSessionUserInput(
  db: TestDb,
  args: { environmentId: string; now: number; terminalId: string },
) {
  return updateTerminalSession(db, {
    now: args.now,
    scope: {
      environmentId: args.environmentId,
      kind: "threadless-environment",
      terminalId: args.terminalId,
    },
    update: { kind: "user-input" },
  });
}

function markTerminalSessionUserInput(
  db: TestDb,
  args: { now: number; terminalId: string; threadId: string },
) {
  return updateTerminalSession(db, {
    now: args.now,
    scope: {
      kind: "thread",
      terminalId: args.terminalId,
      threadId: args.threadId,
    },
    update: { kind: "user-input" },
  });
}

function markTerminalSessionRunning(
  db: TestDb,
  args: {
    cols: number;
    daemonSessionId: string;
    initialCwd: string;
    rows: number;
    terminalId: string;
    title: string;
  },
) {
  return updateTerminalSession(db, {
    scope: {
      daemonSessionId: args.daemonSessionId,
      kind: "daemon",
      statuses: ["starting"],
      terminalId: args.terminalId,
    },
    update: {
      cols: args.cols,
      daemonSessionId: args.daemonSessionId,
      initialCwd: args.initialCwd,
      kind: "running",
      rows: args.rows,
      title: args.title,
    },
  });
}

function markThreadTerminalSessionsExited(
  db: TestDb,
  args: { closeReason: "thread-deleted"; threadId: string },
) {
  return updateTerminalSessions(db, {
    scope: {
      kind: "thread",
      statuses: ["starting", "running", "disconnected"],
      threadId: args.threadId,
    },
    update: { closeReason: args.closeReason, kind: "exit" },
  });
}

function markEnvironmentTerminalSessionsExited(
  db: TestDb,
  args: { closeReason: "environment-destroyed"; environmentId: string },
) {
  return updateTerminalSessions(db, {
    scope: {
      environmentId: args.environmentId,
      kind: "environment",
      statuses: ["starting", "running", "disconnected"],
    },
    update: { closeReason: args.closeReason, kind: "exit" },
  });
}

function markDaemonTerminalSessionsDisconnected(
  db: TestDb,
  args: { daemonSessionId: string },
) {
  return updateTerminalSessions(db, {
    scope: {
      daemonSessionId: args.daemonSessionId,
      kind: "daemon",
      statuses: ["starting", "running"],
    },
    update: { kind: "disconnect" },
  });
}

function openTestSession(db: TestDb, hostId: string): TestSession {
  return openSession(db, {
    hostId,
    instanceId: "inst-1",
    hostName: "test-host",
    dataDir: "/tmp/test-host-data",
    protocolVersion: 1,
    heartbeatIntervalMs: 10_000,
    leaseTimeoutMs: 30_000,
  });
}

function setup(): TerminalSessionFixture {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const session = openTestSession(db, host.id);
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project" },
  });
  const environment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/workspace",
    status: "ready",
    isGitRepo: true,
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

function createStartingThreadlessTerminal(fixture: TerminalSessionFixture) {
  return createTerminalSession(fixture.db, {
    cols: 80,
    daemonSessionId: fixture.session.id,
    environmentId: fixture.environment.id,
    hostId: fixture.host.id,
    initialCwd: "/tmp/workspace",
    rows: 24,
    status: "starting",
    threadId: null,
    title: "Terminal 1",
  });
}

describe("terminal sessions", () => {
  it("keeps threadless environment terminals out of thread terminal queries", () => {
    const fixture = setup();
    const threadTerminal = createStartingTerminal(fixture);
    const threadlessTerminal = createStartingThreadlessTerminal(fixture);

    expect(listTerminalSessionsByThread(fixture.db, fixture.thread.id)).toEqual([
      expect.objectContaining({ id: threadTerminal.id }),
    ]);
    expect(
      listThreadlessTerminalSessionsByEnvironment(
        fixture.db,
        fixture.environment.id,
      ),
    ).toEqual([expect.objectContaining({ id: threadlessTerminal.id })]);
    expect(
      getThreadlessTerminalSessionForEnvironment(fixture.db, {
        environmentId: fixture.environment.id,
        terminalId: threadTerminal.id,
      }),
    ).toBeNull();
  });

  it("marks a threadless terminal dirty on first user input only", () => {
    const fixture = setup();
    const terminal = createStartingThreadlessTerminal(fixture);

    const firstInput = markThreadlessTerminalSessionUserInput(fixture.db, {
      environmentId: fixture.environment.id,
      terminalId: terminal.id,
      now: 10,
    });
    const secondInput = markThreadlessTerminalSessionUserInput(fixture.db, {
      environmentId: fixture.environment.id,
      terminalId: terminal.id,
      now: 20,
    });

    expect(firstInput).toMatchObject({
      id: terminal.id,
      lastUserInputAt: 10,
      updatedAt: 10,
    });
    expect(secondInput).toBeNull();
    expect(
      listVisibleThreadlessTerminalSessionsByEnvironment(
        fixture.db,
        fixture.environment.id,
      ),
    ).toEqual([
      expect.objectContaining({
        id: terminal.id,
        lastUserInputAt: 10,
      }),
    ]);
  });

  it("marks only the expected starting daemon session running", () => {
    const fixture = setup();
    const terminal = createStartingTerminal(fixture);

    const running = markTerminalSessionRunning(fixture.db, {
      cols: 100,
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

  it("marks a terminal dirty on first user input only", () => {
    const fixture = setup();
    const terminal = createStartingTerminal(fixture);

    const firstInput = markTerminalSessionUserInput(fixture.db, {
      terminalId: terminal.id,
      threadId: fixture.thread.id,
      now: 10,
    });
    const secondInput = markTerminalSessionUserInput(fixture.db, {
      terminalId: terminal.id,
      threadId: fixture.thread.id,
      now: 20,
    });

    expect(firstInput).toMatchObject({
      id: terminal.id,
      lastUserInputAt: 10,
      updatedAt: 10,
    });
    expect(secondInput).toBeNull();
    expect(listTerminalSessionsByThread(fixture.db, fixture.thread.id)).toEqual([
      expect.objectContaining({
        id: terminal.id,
        lastUserInputAt: 10,
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

  it("lists starting, running, and disconnected terminals as visible", () => {
    const fixture = setup();
    const starting = createTerminalSession(fixture.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/workspace",
      now: 1,
      rows: 24,
      status: "starting",
      threadId: fixture.thread.id,
      title: "Starting terminal",
    });
    const running = createTerminalSession(fixture.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/workspace",
      now: 2,
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Running terminal",
    });
    const disconnected = createTerminalSession(fixture.db, {
      cols: 80,
      daemonSessionId: null,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/workspace",
      now: 3,
      rows: 24,
      status: "disconnected",
      threadId: fixture.thread.id,
      title: "Disconnected terminal",
    });
    const exited = createTerminalSession(fixture.db, {
      cols: 80,
      daemonSessionId: null,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/workspace",
      now: 4,
      rows: 24,
      status: "exited",
      threadId: fixture.thread.id,
      title: "Exited terminal",
    });

    expect(
      listVisibleTerminalSessionsByThread(fixture.db, fixture.thread.id),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: starting.id }),
        expect.objectContaining({ id: running.id }),
        expect.objectContaining({ id: disconnected.id }),
      ]),
    );
    expect(
      listVisibleTerminalSessionsByThread(fixture.db, fixture.thread.id),
    ).toHaveLength(3);
    expect(
      listVisibleTerminalSessionsByThread(fixture.db, fixture.thread.id),
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: exited.id })]),
    );
  });

  it("does not mark a starting terminal running for another daemon session", () => {
    const fixture = setup();
    const terminal = createStartingTerminal(fixture);
    const replacementSession = openTestSession(fixture.db, fixture.host.id);

    const running = markTerminalSessionRunning(fixture.db, {
      cols: 100,
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

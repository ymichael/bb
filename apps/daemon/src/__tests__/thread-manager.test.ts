import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter, Readable, Writable } from "node:stream";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Thread, ThreadEvent } from "@beanbag/agent-core";
import type {
  ThreadRepository,
  EventRepository,
  ProjectRepository,
} from "@beanbag/db";
import { createCodexProviderAdapter } from "@beanbag/agent-server";
import { ThreadManager } from "../thread-manager.js";
import { WSManager } from "../ws.js";

// Mock child_process.spawn while preserving other exports.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn as spawnMock } from "node:child_process";

const CODEX_THREAD_ID = "codex-thread-abc-123";

/**
 * Create a fake ChildProcess with piped stdio streams.
 * stdout is a real Readable we can push data into.
 * stdin is a Writable that captures writes.
 *
 * When autoRespond is true (default), automatically emits the thread/start
 * response when a thread/start request is written to stdin, so that
 * _waitForResponse resolves.
 */
function createFakeChildProcess(opts?: { autoRespond?: boolean }): ChildProcess & {
  _stdinData: string[];
  _pushStdout: (line: string) => void;
  _pushStderr: (line: string) => void;
  _emitExit: (code: number | null, signal: string | null) => void;
} {
  const autoRespond = opts?.autoRespond ?? true;
  const child = new EventEmitter() as any;
  const stdinData: string[] = [];

  child.stdin = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const data = chunk.toString();
      stdinData.push(data);

      // Auto-respond to thread/start requests
      if (autoRespond) {
        try {
          const msg = JSON.parse(data.trim());
          if (msg.method === "thread/start" && msg.id) {
            // Emit the response on stdout after a tick
            process.nextTick(() => {
              child.stdout.push(
                JSON.stringify({
                  id: msg.id,
                  result: {
                    thread: { id: CODEX_THREAD_ID },
                    model: "test-model",
                  },
                }) + "\n",
              );
            });
          }
        } catch {
          // not JSON, ignore
        }
      }

      callback();
    },
  });
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.pid = 12345;
  child.exitCode = null;
  child.kill = vi.fn();
  child._stdinData = stdinData;
  child._pushStdout = (line: string) => {
    child.stdout.push(line + "\n");
  };
  child._pushStderr = (line: string) => {
    child.stderr.push(line + "\n");
  };
  child._emitExit = (code: number | null, signal: string | null) => {
    child.exitCode = code;
    child.emit("exit", code, signal);
  };

  return child;
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "proj-1",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

type ThreadEventOverrides = Partial<Omit<ThreadEvent, "type" | "data">> & {
  type?: string;
  data?: unknown;
};

function makeEvent(overrides: ThreadEventOverrides = {}): ThreadEvent {
  return {
    id: "evt-1",
    threadId: "thread-1",
    seq: 1,
    type: "item/completed",
    data: {},
    createdAt: 1000,
    ...overrides,
  } as ThreadEvent;
}

function createMocks() {
  const threadRepo = {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    markRead: vi.fn(),
    delete: vi.fn(),
  } as unknown as ThreadRepository;

  const eventRepo = {
    create: vi.fn(),
    listByThread: vi.fn(),
    getLatestSeq: vi.fn(),
    getLatestByType: vi.fn(),
  } as unknown as EventRepository;

  const projectRepo = {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  } as unknown as ProjectRepository;

  const ws = {
    broadcast: vi.fn(),
    handleConnection: vi.fn(),
    close: vi.fn(),
  } as unknown as WSManager;

  return { threadRepo, eventRepo, projectRepo, ws };
}

describe("ThreadManager", () => {
  let threadRepo: ReturnType<typeof createMocks>["threadRepo"];
  let eventRepo: ReturnType<typeof createMocks>["eventRepo"];
  let projectRepo: ReturnType<typeof createMocks>["projectRepo"];
  let ws: ReturnType<typeof createMocks>["ws"];
  let manager: ThreadManager;

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = createMocks();
    threadRepo = mocks.threadRepo;
    eventRepo = mocks.eventRepo;
    projectRepo = mocks.projectRepo;
    ws = mocks.ws;
    manager = new ThreadManager(
      threadRepo as any,
      eventRepo as any,
      projectRepo as any,
      ws as any,
    );
  });

  describe("boot status healing", () => {
    function createBootManager(initialThreads: Thread[]) {
      const threadState = new Map(
        initialThreads.map((thread) => [thread.id, { ...thread }]),
      );
      const bootThreadRepo = {
        create: vi.fn(),
        getById: vi.fn((threadId: string) => threadState.get(threadId)),
        list: vi.fn(() => Array.from(threadState.values())),
        update: vi.fn((threadId: string, updates: Partial<Thread>) => {
          const existing = threadState.get(threadId);
          if (!existing) return undefined;
          const next = {
            ...existing,
            ...updates,
          } as Thread;
          threadState.set(threadId, next);
          return next;
        }),
        markRead: vi.fn(),
        delete: vi.fn(),
      } as unknown as ThreadRepository;

      const bootEventRepo = {
        create: vi.fn(),
        listByThread: vi.fn(),
        getLatestSeq: vi.fn(),
      } as unknown as EventRepository;

      const bootProjectRepo = {
        create: vi.fn(),
        getById: vi.fn(),
        list: vi.fn(),
        delete: vi.fn(),
      } as unknown as ProjectRepository;

      const bootWs = {
        broadcast: vi.fn(),
        handleConnection: vi.fn(),
        close: vi.fn(),
      } as unknown as WSManager;

      const bootManager = new ThreadManager(
        bootThreadRepo as any,
        bootEventRepo as any,
        bootProjectRepo as any,
        bootWs as any,
      );

      return {
        bootManager,
        bootThreadRepo,
        bootEventRepo,
        bootProjectRepo,
        bootWs,
        threadState,
      };
    }

    it("resets persisted active threads to idle when they cannot be resumed", async () => {
      const {
        bootManager,
        bootThreadRepo,
        bootWs,
      } = createBootManager([
        makeThread({ id: "boot-active", status: "active" }),
      ]);

      await bootManager.reconcileActiveThreadsOnBoot();

      expect(bootThreadRepo.update).toHaveBeenCalledWith(
        "boot-active",
        {
          status: "idle",
        },
        {
          touchUpdatedAt: false,
        },
      );
      expect(bootWs.broadcast).toHaveBeenCalledWith("thread", "boot-active", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("applies the restart policy matrix across persisted thread statuses", async () => {
      const {
        bootManager,
        bootThreadRepo,
      } = createBootManager([
        makeThread({ id: "boot-created", status: "created" }),
        makeThread({ id: "boot-provisioning", status: "provisioning" }),
        makeThread({ id: "boot-active", status: "active" }),
        makeThread({ id: "boot-idle", status: "idle" }),
        makeThread({ id: "boot-provisioning-failed", status: "provisioning_failed" }),
        makeThread({
          id: "boot-archived-active",
          status: "active",
          archivedAt: 123,
        }),
        makeThread({
          id: "boot-archived-idle",
          status: "idle",
          archivedAt: 123,
        }),
      ]);

      const scheduleProvisioningSpy = vi
        .spyOn(bootManager as any, "_scheduleProvisioning")
        .mockImplementation(() => {});
      const cleanupRuntimeSpy = vi
        .spyOn(bootManager as any, "_cleanupThreadRuntime")
        .mockImplementation(() => {});

      await bootManager.reconcileActiveThreadsOnBoot();

      expect(scheduleProvisioningSpy).toHaveBeenCalledWith(
        "boot-created",
        {
          projectId: "proj-1",
          environmentId: undefined,
        },
      );
      expect(cleanupRuntimeSpy).toHaveBeenCalledWith("boot-provisioning");
      expect(bootThreadRepo.update).toHaveBeenCalledWith(
        "boot-provisioning",
        { status: "provisioning_failed" },
        { touchUpdatedAt: false },
      );
      expect(bootThreadRepo.update).toHaveBeenCalledWith(
        "boot-active",
        { status: "idle" },
        { touchUpdatedAt: false },
      );
      expect(bootThreadRepo.update).toHaveBeenCalledWith(
        "boot-archived-active",
        { status: "idle" },
        { touchUpdatedAt: false },
      );

      const updatedIds = (bootThreadRepo.update as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call[0] as string);
      expect(updatedIds).not.toContain("boot-idle");
      expect(updatedIds).not.toContain("boot-provisioning-failed");
      expect(updatedIds).not.toContain("boot-archived-idle");
    });
  });

  describe("spawn()", () => {
    let fakeChild: ReturnType<typeof createFakeChildProcess>;

    beforeEach(() => {
      fakeChild = createFakeChildProcess();
      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
    });

    it("spawns codex app-server with correct args and cwd", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/my/project", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      expect(spawnMock).toHaveBeenCalledWith(
        "codex",
        ["app-server"],
        expect.objectContaining({
          stdio: ["pipe", "pipe", "pipe"],
          cwd: "/my/project",
          env: expect.objectContaining({
            BB_PROJECT_ID: "proj-1",
            BB_THREAD_ID: "t-new",
          }),
        }),
      );

      const spawnOptions = (spawnMock as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as
        | { env?: Record<string, string | undefined> }
        | undefined;
      expect(spawnOptions?.env?.BB_TASK_ID).toBeUndefined();
    });

    it("creates a thread record in the DB", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      expect(threadRepo.create).toHaveBeenCalledWith({
        projectId: "proj-1",
        environmentId: "local",
      });
    });

    it("prepends bb path to PATH and injects it into thread/start config", async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "beanbag-thread-manager-"));
      const firstBin = join(tmpRoot, "first-bin");
      const bbBin = join(tmpRoot, "bb-bin");
      mkdirSync(firstBin, { recursive: true });
      mkdirSync(bbBin, { recursive: true });
      const bbPath = join(bbBin, "bb");
      writeFileSync(bbPath, "#!/bin/sh\nexit 0\n", "utf-8");
      chmodSync(bbPath, 0o755);

      const pathValue = [firstBin, bbBin].join(delimiter);
      const runtimeEnv = { ...process.env, PATH: pathValue };

      try {
        const localManager = new ThreadManager(
          threadRepo as any,
          eventRepo as any,
          projectRepo as any,
          ws as any,
          createCodexProviderAdapter(),
          runtimeEnv,
        );

        const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
        (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

        const createdThread = makeThread({ id: "t-new", status: "idle" });
        (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
          makeThread({ id: "t-new", status: "active" }),
        );

        await localManager.spawn({ projectId: "proj-1" });
        await vi.waitFor(() => {
          expect(fakeChild._stdinData.length).toBeGreaterThanOrEqual(2);
        });

        const expectedPath = [bbBin, firstBin].join(delimiter);
        const spawnOptions = (spawnMock as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as
          | { env?: Record<string, string | undefined> }
          | undefined;
        expect(spawnOptions?.env?.PATH).toBe(expectedPath);

        const startMsg = JSON.parse(fakeChild._stdinData[1].trim());
        expect(startMsg.params.config["shell_environment_policy.set.PATH"]).toBe(expectedPath);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("creates a bb shim and injects it into PATH when bb is not on PATH", async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "beanbag-thread-manager-"));
      const firstBin = join(tmpRoot, "first-bin");
      const secondBin = join(tmpRoot, "second-bin");
      mkdirSync(firstBin, { recursive: true });
      mkdirSync(secondBin, { recursive: true });

      const pathValue = [firstBin, secondBin].join(delimiter);
      const runtimeEnv = { ...process.env, PATH: pathValue };

      try {
        const localManager = new ThreadManager(
          threadRepo as any,
          eventRepo as any,
          projectRepo as any,
          ws as any,
          createCodexProviderAdapter(),
          runtimeEnv,
        );

        const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
        (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

        const createdThread = makeThread({ id: "t-new", status: "idle" });
        (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
          makeThread({ id: "t-new", status: "active" }),
        );

        await localManager.spawn({ projectId: "proj-1" });
        await vi.waitFor(() => {
          expect(fakeChild._stdinData.length).toBeGreaterThanOrEqual(2);
        });

        const spawnOptions = (spawnMock as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as
          | { env?: Record<string, string | undefined> }
          | undefined;
        const injectedPath = spawnOptions?.env?.PATH;
        expect(typeof injectedPath).toBe("string");
        expect(injectedPath).toBeTruthy();

        const firstEntry = injectedPath!.split(delimiter)[0];
        const shimPath = join(firstEntry, "bb");
        expect(existsSync(shimPath)).toBe(true);
        expect(() => accessSync(shimPath, constants.X_OK)).not.toThrow();

        const shimScript = readFileSync(shimPath, "utf-8");
        const hasNodeRunner = shimScript.includes(`"${process.execPath}"`);
        const hasTsxRunner = shimScript.includes("/tsx\"");
        expect(hasNodeRunner || hasTsxRunner).toBe(true);
        expect(shimScript).toContain('"$@"');

        const startMsg = JSON.parse(fakeChild._stdinData[1].trim());
        expect(startMsg.params.config["shell_environment_policy.set.PATH"]).toBe(
          injectedPath,
        );
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("registers the process and marks thread as active", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      expect(manager.isActive("t-new")).toBe(true);
      expect(manager.getActiveCount()).toBe(1);
    });

    it("updates thread status through provisioning and broadcasts", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "provisioning" });
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "t-new", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("sends initialize and thread/start JSON-RPC to the child process stdin", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      // Should have written initialize + thread/start to stdin
      expect(fakeChild._stdinData.length).toBeGreaterThanOrEqual(2);

      // First message: initialize
      const initMsg = JSON.parse(fakeChild._stdinData[0].trim());
      expect(initMsg.jsonrpc).toBe("2.0");
      expect(initMsg.method).toBe("initialize");
      expect(initMsg.params.clientInfo.name).toBe("beanbag");
      expect(initMsg.params.capabilities?.optOutNotificationMethods).toEqual(
        expect.arrayContaining([
          "codex/event/item_started",
          "codex/event/item_completed",
        ]),
      );
      expect(initMsg.id).toBe(1);

      // Second message: thread/start
      const startMsg = JSON.parse(fakeChild._stdinData[1].trim());
      expect(startMsg.jsonrpc).toBe("2.0");
      expect(startMsg.method).toBe("thread/start");
      expect(startMsg.params.approvalPolicy).toBe("never");
      expect(startMsg.params.sandbox).toBe("danger-full-access");
      expect(startMsg.params.baseInstructions).toContain("coding agent");
      expect(startMsg.params.config["shell_environment_policy.set.BB_PROJECT_ID"]).toBe("proj-1");
      expect(startMsg.params.config["shell_environment_policy.set.BB_THREAD_ID"]).toBe("t-new");
      expect(startMsg.id).toBe(2);
    });

    it("sends turn/start when input is provided", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Fix the login bug" }],
      });

      await vi.waitFor(() => {
        expect(fakeChild._stdinData.length).toBe(3);
      });

      // Should have written initialize + thread/start + turn/start
      const turnMsg = JSON.parse(fakeChild._stdinData[2].trim());
      expect(turnMsg.jsonrpc).toBe("2.0");
      expect(turnMsg.method).toBe("turn/start");
      expect(turnMsg.params.threadId).toBe(CODEX_THREAD_ID);
      expect(turnMsg.params.input).toEqual([{ type: "text", text: "Fix the login bug" }]);
      expect(turnMsg.params.approvalPolicy).toBe("never");
      expect(turnMsg.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
      expect(turnMsg.id).toBe(3);
    });

    it("maps developerInstructions onto thread/start baseInstructions", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({
        projectId: "proj-1",
        developerInstructions: "[bb system] test developer instructions",
      });

      const startMsg = JSON.parse(fakeChild._stdinData[1].trim());
      expect(startMsg.params.baseInstructions).toBe(
        "[bb system] test developer instructions",
      );
      expect(startMsg.params.developerInstructions).toBeUndefined();
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "client/thread/start",
          data: expect.objectContaining({
            request: expect.objectContaining({
              params: expect.objectContaining({
                baseInstructions: "[bb system] test developer instructions",
              }),
            }),
          }),
        }),
      );
    });

    it("lets environment adapters customize developer instructions", async () => {
      const customizeDeveloperInstructions = vi.fn(
        (currentInstructions: string | undefined) =>
          [currentInstructions, "[bb worktree] commit work often"]
            .filter((value): value is string => Boolean(value))
            .join("\n\n"),
      );
      const customEnvironmentAdapter = {
        info: {
          id: "worktree",
          displayName: "Git Worktree Workspace",
          description: "",
          capabilities: {
            isolatedFilesystem: true,
            ephemeralWorkspace: true,
            supportsCleanup: true,
          },
        },
        prepare: vi.fn(() => ({
          cwd: "/tmp/thread-worktree",
          env: {
            BB_WORKSPACE_ROOT: "/tmp/thread-worktree",
            BB_WORKSPACE_MODE: "worktree",
          },
          metadata: {
            mode: "worktree",
            workspaceRoot: "/tmp/thread-worktree",
          },
        })),
        customizeDeveloperInstructions,
      };
      const managerWithCustomEnvironment = new ThreadManager(
        threadRepo as any,
        eventRepo as any,
        projectRepo as any,
        ws as any,
        createCodexProviderAdapter(),
        process.env,
        customEnvironmentAdapter as any,
      );

      const project = {
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
        workflowInstructions: "[project workflow] keep CI green",
      };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({
        id: "t-new",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active", environmentId: "worktree" }),
      );

      await managerWithCustomEnvironment.spawn({
        projectId: "proj-1",
        environmentId: "worktree",
        developerInstructions: "[request instructions] add tests",
      });

      const startMsg = JSON.parse(fakeChild._stdinData[1].trim());
      expect(startMsg.params.baseInstructions).toBe(
        [
          "[project workflow] keep CI green",
          "[request instructions] add tests",
          "[bb worktree] commit work often",
        ].join("\n\n"),
      );
      expect(customizeDeveloperInstructions).toHaveBeenCalledWith(
        [
          "[project workflow] keep CI green",
          "[request instructions] add tests",
        ].join("\n\n"),
        expect.objectContaining({
          projectId: "proj-1",
          threadId: "t-new",
          requestedEnvironmentId: "worktree",
          effectiveEnvironmentId: "worktree",
          mode: "worktree",
          workspaceRootPath: "/tmp/thread-worktree",
        }),
      );
    });

    it("records environment provisioning events emitted by the adapter", async () => {
      const customEnvironmentAdapter = {
        info: {
          id: "worktree",
          displayName: "Git Worktree Workspace",
          description: "",
          capabilities: {
            isolatedFilesystem: true,
            ephemeralWorkspace: true,
            supportsCleanup: true,
          },
        },
        prepare: vi.fn((context: { onProvisioningEvent?: (event: unknown) => void }) => {
          context.onProvisioningEvent?.({
            type: "env-setup",
            status: "started",
            scriptPath: ".bb-env-setup.ts",
            timeoutMs: 600000,
          });
          context.onProvisioningEvent?.({
            type: "env-setup",
            status: "completed",
            scriptPath: ".bb-env-setup.ts",
            timeoutMs: 600000,
            durationMs: 42,
          });
          return {
            cwd: "/tmp/thread-worktree",
            env: {
              BB_WORKSPACE_ROOT: "/tmp/thread-worktree",
              BB_WORKSPACE_MODE: "worktree",
            },
            metadata: {
              mode: "worktree",
              workspaceRoot: "/tmp/thread-worktree",
            },
          };
        }),
      };
      const managerWithCustomEnvironment = new ThreadManager(
        threadRepo as any,
        eventRepo as any,
        projectRepo as any,
        ws as any,
        createCodexProviderAdapter(),
        process.env,
        customEnvironmentAdapter as any,
      );

      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({
        id: "t-new",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active", environmentId: "worktree" }),
      );

      await managerWithCustomEnvironment.spawn({
        projectId: "proj-1",
        environmentId: "worktree",
      });

      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-new",
          type: "system/provisioning/env_setup",
          data: expect.objectContaining({
            status: "started",
            scriptPath: ".bb-env-setup.ts",
            timeoutMs: 600000,
          }),
        }),
      );
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-new",
          type: "system/provisioning/env_setup",
          data: expect.objectContaining({
            status: "completed",
            scriptPath: ".bb-env-setup.ts",
            durationMs: 42,
          }),
        }),
      );
    });

    it("does not auto-generate spawn titles from input", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Fix flaky login redirect" }],
      });

      expect(threadRepo.create).toHaveBeenCalledWith({
        projectId: "proj-1",
        environmentId: "local",
      });
    });

    it("returns prompt-derived title fallback when spawned without an explicit title", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);

      const result = await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Fix flaky login redirect" }],
      });

      expect(result.title).toBeUndefined();
      expect(result.titleFallback).toBe("Fix flaky login redirect");
    });

    it("auto-generates and persists thread names when provider title generation is enabled", async () => {
      const providerTitleGenerator = vi
        .fn()
        .mockResolvedValue("Generated Login Fix Title");
      const titleManager = new ThreadManager(
        threadRepo as any,
        eventRepo as any,
        projectRepo as any,
        ws as any,
        createCodexProviderAdapter({ titleGenerator: providerTitleGenerator }),
      );

      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      let persistedThread = makeThread({
        id: "t-new",
        status: "active",
      });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        () => persistedThread,
      );
      (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, updates: { status?: Thread["status"]; title?: string }) => {
          persistedThread = {
            ...persistedThread,
            ...(updates.status !== undefined ? { status: updates.status } : {}),
            ...(updates.title !== undefined ? { title: updates.title } : {}),
          };
          return persistedThread;
        },
      );

      await titleManager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Fix the login bug" }],
      });

      await vi.waitFor(() => {
        expect(providerTitleGenerator).toHaveBeenCalledTimes(1);
      });
      expect(providerTitleGenerator).toHaveBeenCalledWith({
        input: [{ type: "text", text: "Fix the login bug" }],
        cwd: "/test",
      });

      const renameMsgRaw = fakeChild._stdinData
        .map((entry) => JSON.parse(entry.trim()))
        .find((entry) => entry.method === "thread/name/set");
      expect(renameMsgRaw).toBeDefined();
      expect(renameMsgRaw.params).toEqual({
        threadId: CODEX_THREAD_ID,
        name: "Generated Login Fix Title",
      });
      expect(persistedThread.title).toBe("Generated Login Fix Title");
    });

    it("sends explicit spawn titles to provider after thread startup", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({
        id: "t-new",
        status: "idle",
        title: "Pinned custom title",
      });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        () => makeThread({
          id: "t-new",
          status: "active",
          title: "Pinned custom title",
        }),
      );

      await manager.spawn({
        projectId: "proj-1",
        title: "Pinned custom title",
      });

      await vi.waitFor(() => {
        const hasRename = fakeChild._stdinData
          .map((entry) => JSON.parse(entry.trim()))
          .some((entry) => entry.method === "thread/name/set");
        expect(hasRename).toBe(true);
      });

      const renameMsgRaw = fakeChild._stdinData
        .map((entry) => JSON.parse(entry.trim()))
        .find((entry) => entry.method === "thread/name/set");
      expect(renameMsgRaw).toBeDefined();
      expect(renameMsgRaw.params).toEqual({
        threadId: CODEX_THREAD_ID,
        name: "Pinned custom title",
      });
    });

    it("sends turn/start when multimodal input is provided", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({
        projectId: "proj-1",
        input: [
          { type: "text", text: "Please review these references." },
          { type: "image", url: "https://example.com/diagram.png" },
          { type: "localImage", path: "/tmp/local-diagram.png" },
        ],
      });

      await vi.waitFor(() => {
        expect(fakeChild._stdinData.length).toBe(3);
      });
      const turnMsg = JSON.parse(fakeChild._stdinData[2].trim());
      expect(turnMsg.method).toBe("turn/start");
      expect(turnMsg.params.threadId).toBe(CODEX_THREAD_ID);
      expect(turnMsg.params.input).toEqual([
        { type: "text", text: "Please review these references." },
        { type: "image", url: "https://example.com/diagram.png" },
        { type: "localImage", path: "/tmp/local-diagram.png" },
      ]);
      expect(turnMsg.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    });

    it("maps local file attachments to text annotations for provider compatibility", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({
        projectId: "proj-1",
        input: [
          { type: "text", text: "Please use the attached spec." },
          {
            type: "localFile",
            path: "/tmp/spec.md",
            name: "spec.md",
            sizeBytes: 42,
            mimeType: "text/markdown",
          },
        ],
      });

      await vi.waitFor(() => {
        expect(fakeChild._stdinData.length).toBe(3);
      });
      const turnMsg = JSON.parse(fakeChild._stdinData[2].trim());
      expect(turnMsg.method).toBe("turn/start");
      expect(turnMsg.params.threadId).toBe(CODEX_THREAD_ID);
      expect(turnMsg.params.input).toEqual([
        { type: "text", text: "Please use the attached spec." },
        { type: "text", text: "Attached local file: /tmp/spec.md" },
      ]);
    });

    it("includes model and reasoning config when input options are provided", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Fix the login bug" }],
        model: "gpt-5-codex",
        reasoningLevel: "high",
      });

      await vi.waitFor(() => {
        expect(fakeChild._stdinData.length).toBe(3);
      });

      const startMsg = JSON.parse(fakeChild._stdinData[1].trim());
      expect(startMsg.params.model).toBe("gpt-5-codex");
      expect(startMsg.params.config).toMatchObject({
        model_reasoning_effort: "high",
        "shell_environment_policy.set.BB_PROJECT_ID": "proj-1",
        "shell_environment_policy.set.BB_THREAD_ID": "t-new",
      });
      expect(startMsg.params.sandbox).toBe("danger-full-access");

      const turnMsg = JSON.parse(fakeChild._stdinData[2].trim());
      expect(turnMsg.params.model).toBe("gpt-5-codex");
      expect(turnMsg.params.config).toEqual({
        model_reasoning_effort: "high",
      });
      expect(turnMsg.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    });

    it("does NOT send turn/start when no input is provided", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      // Only initialize + thread/start, no turn/start
      expect(fakeChild._stdinData.length).toBe(2);
    });

    it("persists initial input on outbound client/thread/start events", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      const input = [{ type: "text", text: "Fix provisioning status UI" }] as const;
      await manager.spawn({ projectId: "proj-1", input: [...input] });

      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "client/thread/start",
          data: expect.objectContaining({
            input,
          }),
        }),
      );
    });

    it("throws if project not found", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      await expect(
        manager.spawn({ projectId: "bad-proj" }),
      ).rejects.toThrow("Project bad-proj not found");

      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("returns the created thread record immediately after spawn", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);

      const updatedThread = makeThread({ id: "t-new", status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(updatedThread);

      const result = await manager.spawn({ projectId: "proj-1" });

      expect(result).toBe(createdThread);
      expect(result.status).toBe("idle");
    });

    it("marks thread provisioning_failed if spawn setup errors", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);

      // Make spawn throw
      (spawnMock as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("ENOENT: codex not found");
      });

      const result = await manager.spawn({ projectId: "proj-1" });
      expect(result).toBe(createdThread);
      await vi.waitFor(() => {
        expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "provisioning_failed" });
      });

      expect(ws.broadcast).toHaveBeenCalledWith("thread", "t-new", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("marks thread provisioning_failed when codex returns RPC error to thread/start", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-err", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);

      // Use a non-auto-responding child, manually return an error
      const errorChild = createFakeChildProcess({ autoRespond: false });
      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValue(errorChild);

      // After the thread/start write, push an error response
      errorChild.stdin = new Writable({
        write(chunk: Buffer, _encoding: string, callback: () => void) {
          const data = chunk.toString();
          errorChild._stdinData.push(data);
          try {
            const msg = JSON.parse(data.trim());
            if (msg.method === "thread/start" && msg.id) {
              process.nextTick(() => {
                errorChild.stdout!.push(
                  JSON.stringify({
                    id: msg.id,
                    error: { code: -32600, message: "Invalid params" },
                  }) + "\n",
                );
              });
            }
          } catch {}
          callback();
        },
      });

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(threadRepo.update).toHaveBeenCalledWith("t-err", { status: "provisioning_failed" });
      });
    });

    it("marks thread provisioning_failed when thread/start times out", async () => {
      vi.useFakeTimers();
      try {
        const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
        (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

        const createdThread = makeThread({ id: "t-timeout", status: "idle" });
        (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);

        // Use non-auto-responding child — thread/start will never get a response
        const silentChild = createFakeChildProcess({ autoRespond: false });
        (spawnMock as ReturnType<typeof vi.fn>).mockReturnValue(silentChild);

        await manager.spawn({ projectId: "proj-1" });

        // Advance past the 10s timeout
        await vi.advanceTimersByTimeAsync(10_001);
        await vi.waitFor(() => {
          expect(threadRepo.update).toHaveBeenCalledWith("t-timeout", {
            status: "provisioning_failed",
          });
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("logs JSON-RPC errors from codex in event streaming", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await manager.spawn({ projectId: "proj-1" });

      // Push a JSON-RPC error response on stdout (as if codex rejected a request)
      fakeChild._pushStdout(
        JSON.stringify({
          id: 99,
          error: { code: -32600, message: "Bad request" },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("RPC error"),
        expect.stringContaining("Bad request"),
      );

      consoleSpy.mockRestore();
    });

    it("summarizes refresh-token reuse stderr as a single warning", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-auth", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-auth", status: "active" }),
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await manager.spawn({ projectId: "proj-1" });

      fakeChild._pushStderr(
        "2026-02-12T04:44:47.619501Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {",
      );
      fakeChild._pushStderr('  "error": {');
      fakeChild._pushStderr(
        '    "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",',
      );
      fakeChild._pushStderr('    "type": "invalid_request_error",');
      fakeChild._pushStderr('    "code": "refresh_token_reused"');
      fakeChild._pushStderr("  }");
      fakeChild._pushStderr("}");
      fakeChild._pushStderr(
        "2026-02-12T04:44:47.619583Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("provider auth refresh conflict"),
      );
      const sawRefreshTokenStderr = errorSpy.mock.calls.some((call) =>
        call.some(
          (arg) => typeof arg === "string" && arg.includes("refresh token"),
        ),
      );
      expect(sawRefreshTokenStderr).toBe(false);

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("keeps logging unrelated stderr lines as errors", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-stderr", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-stderr", status: "active" }),
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await manager.spawn({ projectId: "proj-1" });

      fakeChild._pushStderr("panic: synthetic stderr failure");
      await new Promise((r) => setTimeout(r, 50));

      expect(errorSpy).toHaveBeenCalledWith(
        "[thread t-stderr] stderr: panic: synthetic stderr failure",
      );

      errorSpy.mockRestore();
    });

    it("streams stdout JSON-RPC notifications as events", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      // Simulate codex sending JSON-RPC notifications on stdout
      fakeChild._pushStdout(
        JSON.stringify({ method: "item/started", params: { itemId: "i1" } }),
      );
      fakeChild._pushStdout(
        JSON.stringify({ method: "item/completed", params: { content: "done" } }),
      );

      // Give the readline interface time to process
      await new Promise((r) => setTimeout(r, 50));

      const createdEvents = (eventRepo.create as ReturnType<typeof vi.fn>).mock.calls
        .map(([event]) => event);
      const startedEvent = createdEvents.find((event) => event.type === "item/started");
      const completedEvent = createdEvents.find((event) => event.type === "item/completed");

      expect(startedEvent).toEqual({
        threadId: "t-new",
        seq: expect.any(Number),
        type: "item/started",
        data: expect.objectContaining({
          __bb_provider_event: expect.objectContaining({
            providerId: "codex",
            method: "item/started",
          }),
          payload: { itemId: "i1" },
        }),
      });
      expect(completedEvent).toEqual({
        threadId: "t-new",
        seq: expect.any(Number),
        type: "item/completed",
        data: expect.objectContaining({
          __bb_provider_event: expect.objectContaining({
            providerId: "codex",
            method: "item/completed",
          }),
          payload: { content: "done" },
        }),
      });
    });

    it("suppresses duplicate legacy codex item lifecycle notifications", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "idle" });
      });
      (ws.broadcast as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({
          method: "codex/event/item_completed",
          params: {
            id: "turn-1",
            msg: {
              type: "item_completed",
              turn_id: "turn-1",
              item: {
                type: "AgentMessage",
                id: "msg-1",
                content: [{ type: "Text", text: "duplicate legacy item event" }],
              },
            },
          },
        }),
      );
      fakeChild._pushStdout(
        JSON.stringify({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "msg-1",
              text: "canonical item event",
            },
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      const createdEvents = (eventRepo.create as ReturnType<typeof vi.fn>).mock.calls
        .map(([event]) => event);
      const canonicalCompletedEvent = createdEvents.find(
        (event) => event.type === "item/completed",
      );
      expect(canonicalCompletedEvent).toEqual({
        threadId: "t-new",
        seq: expect.any(Number),
        type: "item/completed",
        data: expect.objectContaining({
          __bb_provider_event: expect.objectContaining({
            providerId: "codex",
            method: "item/completed",
          }),
          payload: {
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "msg-1",
              text: "canonical item event",
            },
          },
        }),
      });
      expect(eventRepo.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: "codex/event/item_completed",
        }),
      );
      expect(ws.broadcast).toHaveBeenCalledTimes(1);
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "t-new", ["events-appended"]);
    });

    it("does not broadcast thread changes for high-frequency delta notifications", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "idle" });
      });
      (ws.broadcast as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "hel" } }),
      );

      await new Promise((r) => setTimeout(r, 50));

      const createdEvents = (eventRepo.create as ReturnType<typeof vi.fn>).mock.calls
        .map(([event]) => event);
      const deltaEvent = createdEvents.find(
        (event) => event.type === "item/agentMessage/delta",
      );
      expect(deltaEvent).toEqual({
        threadId: "t-new",
        seq: expect.any(Number),
        type: "item/agentMessage/delta",
        data: expect.objectContaining({
          __bb_provider_event: expect.objectContaining({
            providerId: "codex",
            method: "item/agentMessage/delta",
          }),
          payload: { delta: "hel" },
        }),
      });
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("broadcasts thread changes for item completion notifications", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      (ws.broadcast as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({ method: "item/completed", params: { item: { type: "agentMessage", text: "done" } } }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(ws.broadcast).toHaveBeenCalledWith("thread", "t-new", ["events-appended"]);
    });

    it("marks thread idle when turn/completed is received", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(JSON.stringify({ method: "turn/completed", params: {} }));

      await new Promise((r) => setTimeout(r, 50));

      expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "idle" });
    });

    it("marks thread active when turn/started is received", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "idle" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(JSON.stringify({ method: "turn/started", params: {} }));

      await new Promise((r) => setTimeout(r, 50));

      expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "active" });
    });

    it("tracks active turn IDs from turn lifecycle events", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      fakeChild._pushStdout(
        JSON.stringify({ method: "turn/started", params: { turnId: "turn-77" } }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect((manager as any).activeTurnIds.get("t-new")).toBe("turn-77");

      fakeChild._pushStdout(
        JSON.stringify({ method: "turn/completed", params: { turnId: "turn-77" } }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect((manager as any).activeTurnIds.has("t-new")).toBe(false);
    });

    it("notifies parent thread when a child turn completes", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      const childThread = makeThread({
        id: "t-child",
        status: "active",
        parentThreadId: "parent-1",
      });
      const parentThread = makeThread({
        id: "parent-1",
        status: "idle",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(childThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        (id: string) => {
          if (id === "t-child") return childThread;
          if (id === "parent-1") return parentThread;
          return undefined;
        },
      );

      const parentStdinData: string[] = [];
      const parentProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            parentStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("parent-1", parentProcess);
      (manager as any).providerThreadIds.set("parent-1", "codex-parent-thread");

      await manager.spawn({ projectId: "proj-1", parentThreadId: "parent-1" });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/completed",
          params: { turnId: "turn-child-1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(parentStdinData.length).toBe(1);
      const notifyMsg = JSON.parse(parentStdinData[0].trim());
      expect(notifyMsg.method).toBe("turn/start");
      expect(notifyMsg.params.threadId).toBe("codex-parent-thread");
      expect(notifyMsg.params.input).toEqual([
        {
          type: "text",
          text: expect.stringContaining("[bb system] Thread"),
        },
      ]);
      expect(notifyMsg.params.input[0].text).toContain("t-child");
    });

    it("dedupes parent notifications when duplicate completion events share the same turnId", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      const childThread = makeThread({
        id: "t-child",
        status: "active",
        parentThreadId: "parent-1",
      });
      const parentThread = makeThread({
        id: "parent-1",
        status: "idle",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(childThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        (id: string) => {
          if (id === "t-child") return childThread;
          if (id === "parent-1") return parentThread;
          return undefined;
        },
      );

      const parentStdinData: string[] = [];
      const parentProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            parentStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("parent-1", parentProcess);
      (manager as any).providerThreadIds.set("parent-1", "codex-parent-thread");

      await manager.spawn({ projectId: "proj-1", parentThreadId: "parent-1" });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/completed",
          params: { turnId: "turn-child-1" },
        }),
      );
      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/end",
          params: { turnId: "turn-child-1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(parentStdinData.length).toBe(1);
    });

    it("dedupes no-turn-id completion events within the same lifecycle epoch", async () => {
      const project = {
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
      };
      const childThread = makeThread({
        id: "t-child",
        status: "active",
        parentThreadId: "parent-1",
      });
      const parentThread = makeThread({
        id: "parent-1",
        status: "idle",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(childThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        (id: string) => {
          if (id === "t-child") return childThread;
          if (id === "parent-1") return parentThread;
          return undefined;
        },
      );

      const parentStdinData: string[] = [];
      const parentProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            parentStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("parent-1", parentProcess);
      (manager as any).providerThreadIds.set("parent-1", "codex-parent-thread");

      await manager.spawn({ projectId: "proj-1", parentThreadId: "parent-1" });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/started",
          params: {},
        }),
      );
      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/completed",
          params: {},
        }),
      );
      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/end",
          params: {},
        }),
      );
      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/started",
          params: {},
        }),
      );
      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/completed",
          params: {},
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(parentStdinData.length).toBe(2);
    });

    it("does not notify parent thread when parent project differs from child project", async () => {
      const project = {
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
      };
      const childThread = makeThread({
        id: "t-child",
        status: "active",
        projectId: "proj-1",
        parentThreadId: "parent-1",
      });
      const parentThread = makeThread({
        id: "parent-1",
        status: "idle",
        projectId: "proj-2",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(childThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        (id: string) => {
          if (id === "t-child") return childThread;
          if (id === "parent-1") return parentThread;
          return undefined;
        },
      );

      const parentStdinData: string[] = [];
      const parentProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            parentStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("parent-1", parentProcess);
      (manager as any).providerThreadIds.set("parent-1", "codex-parent-thread");

      await manager.spawn({ projectId: "proj-1", parentThreadId: "parent-1" });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/completed",
          params: { turnId: "turn-child-1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(parentStdinData.length).toBe(0);
    });

    it("does not notify parent thread for non-completion lifecycle events", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      const childThread = makeThread({
        id: "t-child",
        status: "active",
        parentThreadId: "parent-1",
      });
      const parentThread = makeThread({
        id: "parent-1",
        status: "idle",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(childThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        (id: string) => {
          if (id === "t-child") return childThread;
          if (id === "parent-1") return parentThread;
          return undefined;
        },
      );

      const parentStdinData: string[] = [];
      const parentProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            parentStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("parent-1", parentProcess);
      (manager as any).providerThreadIds.set("parent-1", "codex-parent-thread");

      await manager.spawn({ projectId: "proj-1", parentThreadId: "parent-1" });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/started",
          params: { turnId: "turn-child-1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(parentStdinData.length).toBe(0);
    });

    it("sets title from thread/started preview when thread title is missing", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      const persistedThread = makeThread({ id: "t-new", status: "active" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(() => persistedThread);
      (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, updates: { status?: Thread["status"]; title?: string }) => {
          if (updates.status !== undefined) persistedThread.status = updates.status;
          if (updates.title !== undefined) persistedThread.title = updates.title;
          return persistedThread;
        },
      );

      await manager.spawn({ projectId: "proj-1" });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({
          method: "thread/started",
          params: {
            thread: {
              id: CODEX_THREAD_ID,
              preview: "Draft migration checklist",
            },
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(threadRepo.update).toHaveBeenCalledWith("t-new", {
        title: "Draft migration checklist",
      });
    });

    it("sets title from thread/name/updated when title is not locked", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      const persistedThread = makeThread({ id: "t-new", status: "active" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(() => persistedThread);
      (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, updates: { status?: Thread["status"]; title?: string }) => {
          if (updates.status !== undefined) persistedThread.status = updates.status;
          if (updates.title !== undefined) persistedThread.title = updates.title;
          return persistedThread;
        },
      );

      await manager.spawn({ projectId: "proj-1" });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({
          method: "thread/name/updated",
          params: {
            threadId: CODEX_THREAD_ID,
            threadName: "Server-assigned title",
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(threadRepo.update).toHaveBeenCalledWith("t-new", {
        title: "Server-assigned title",
      });
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-new",
          type: "system/thread-title/updated",
          data: expect.objectContaining({
            title: "Server-assigned title",
            source: "provider",
            providerMethod: "thread/name/updated",
          }),
        }),
      );
    });

    it("does not overwrite explicit spawn title from thread/name/updated", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({
        id: "t-new",
        status: "idle",
        title: "Pinned custom title",
      });
      const persistedThread = makeThread({
        id: "t-new",
        status: "active",
        title: "Pinned custom title",
      });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(() => persistedThread);
      (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, updates: { status?: Thread["status"]; title?: string }) => {
          if (updates.status !== undefined) persistedThread.status = updates.status;
          if (updates.title !== undefined) persistedThread.title = updates.title;
          return persistedThread;
        },
      );

      await manager.spawn({
        projectId: "proj-1",
        title: "Pinned custom title",
      });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({
          method: "thread/name/updated",
          params: {
            threadId: CODEX_THREAD_ID,
            threadName: "Server-assigned title",
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(threadRepo.update).not.toHaveBeenCalledWith("t-new", {
        title: "Server-assigned title",
      });
    });

    it("does not rename when thread already has an explicit spawn title", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({
        id: "t-new",
        status: "idle",
        title: "Fix flaky login redirect",
      });
      const persistedThread = makeThread({
        id: "t-new",
        status: "active",
        title: "Fix flaky login redirect",
      });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(() => persistedThread);
      (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, updates: { status?: Thread["status"]; title?: string }) => {
          if (updates.status !== undefined) persistedThread.status = updates.status;
          if (updates.title !== undefined) persistedThread.title = updates.title;
          return persistedThread;
        },
      );

      await manager.spawn({
        projectId: "proj-1",
        title: "Fix flaky login redirect",
        input: [{ type: "text", text: "Fix flaky login redirect" }],
      });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({
          method: "thread/name/updated",
          params: {
            threadId: CODEX_THREAD_ID,
            threadName: "Server refined title",
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(threadRepo.update).not.toHaveBeenCalledWith("t-new", {
        title: "Server refined title",
      });
      expect(persistedThread.title).toBe("Fix flaky login redirect");
    });

    it("only applies provider thread/name/updated once when a title is missing", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      const persistedThread = makeThread({ id: "t-new", status: "active" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(() => persistedThread);
      (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, updates: { status?: Thread["status"]; title?: string }) => {
          if (updates.status !== undefined) persistedThread.status = updates.status;
          if (updates.title !== undefined) persistedThread.title = updates.title;
          return persistedThread;
        },
      );

      await manager.spawn({ projectId: "proj-1" });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({
          method: "thread/name/updated",
          params: {
            threadId: CODEX_THREAD_ID,
            threadName: "First server title",
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 20));

      fakeChild._pushStdout(
        JSON.stringify({
          method: "thread/name/updated",
          params: {
            threadId: CODEX_THREAD_ID,
            threadName: "Second server title",
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(threadRepo.update).toHaveBeenCalledWith("t-new", {
        title: "First server title",
      });
      expect(threadRepo.update).not.toHaveBeenCalledWith("t-new", {
        title: "Second server title",
      });
      expect(persistedThread.title).toBe("First server title");
    });

    it("ignores blank lines on stdout", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      // Push blank/whitespace lines
      fakeChild._pushStdout("");
      fakeChild._pushStdout("   ");
      // Push one valid message
      fakeChild._pushStdout(JSON.stringify({ method: "turn/start", params: {} }));

      await new Promise((r) => setTimeout(r, 50));

      // Provisioning started/completed + outbound thread/start + valid notification
      expect(eventRepo.create).toHaveBeenCalledTimes(4);
    });

    it("ignores non-JSON stdout output", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      // Push debug output that isn't JSON
      fakeChild._pushStdout("DEBUG: some internal message");
      fakeChild._pushStdout("Error: something happened");

      await new Promise((r) => setTimeout(r, 50));

      expect(eventRepo.create).toHaveBeenCalledTimes(3);
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-new",
          type: "client/thread/start",
        }),
      );
    });

    it("ignores JSON without method field (non-notification)", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      // Push JSON-RPC responses (have result but no method)
      fakeChild._pushStdout(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));

      await new Promise((r) => setTimeout(r, 50));

      expect(eventRepo.create).toHaveBeenCalledTimes(3);
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-new",
          type: "client/thread/start",
        }),
      );
    });

    it("uses empty object as data when notification has no params", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      fakeChild._pushStdout(JSON.stringify({ method: "turn/end" }));

      await new Promise((r) => setTimeout(r, 50));

      const createdEvents = (eventRepo.create as ReturnType<typeof vi.fn>).mock.calls
        .map(([event]) => event);
      const turnEndEvent = createdEvents.find((event) => event.type === "turn/end");
      expect(turnEndEvent).toEqual({
        threadId: "t-new",
        seq: expect.any(Number),
        type: "turn/end",
        data: expect.objectContaining({
          __bb_provider_event: expect.objectContaining({
            providerId: "codex",
            method: "turn/end",
          }),
          payload: {},
        }),
      });
    });

    it("handles process exit events correctly", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      expect(manager.isActive("t-new")).toBe(true);

      // Simulate process exiting with code 0
      fakeChild._emitExit(0, null);

      expect(manager.isActive("t-new")).toBe(false);
      expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "idle" });
    });

    it("handles process error events", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await manager.spawn({ projectId: "proj-1" });

      // Simulate process error
      fakeChild.emit("error", new Error("Process crashed"));

      expect(manager.isActive("t-new")).toBe(false);
      // Error handler calls _handleProcessExit(id, 1, null) which should set idle
      expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "idle" });

      consoleSpy.mockRestore();
    });

    it("increments RPC IDs across multiple spawns", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      // First spawn with input: initialize(1) + thread/start(2) + turn/start(3)
      const thread1 = makeThread({ id: "t-1", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(thread1);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-1", status: "active" }),
      );

      const child1 = createFakeChildProcess();
      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValueOnce(child1);

      await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "First" }],
      });
      await vi.waitFor(() => {
        expect(child1._stdinData.length).toBeGreaterThanOrEqual(3);
      });

      // initialize gets id=1, thread/start gets id=2, turn/start gets id=3
      const initMsg = JSON.parse(child1._stdinData[0].trim());
      const startMsg = JSON.parse(child1._stdinData[1].trim());
      const turnMsg = JSON.parse(child1._stdinData[2].trim());
      expect(initMsg.id).toBe(1);
      expect(startMsg.id).toBe(2);
      expect(turnMsg.id).toBe(3);

      // Second spawn: initialize(4) + thread/start(5)
      const thread2 = makeThread({ id: "t-2", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(thread2);

      const child2 = createFakeChildProcess();
      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValueOnce(child2);

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(child2._stdinData.length).toBeGreaterThanOrEqual(2);
      });

      // initialize gets id=4, thread/start gets id=5
      const initMsg2 = JSON.parse(child2._stdinData[0].trim());
      const startMsg2 = JSON.parse(child2._stdinData[1].trim());
      expect(initMsg2.id).toBe(4);
      expect(startMsg2.id).toBe(5);
    });
  });

  describe("tell()", () => {
    it("throws if thread not found", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      await expect(
        manager.tell("nonexistent", { input: [{ type: "text", text: "hello" }] }),
      ).rejects.toThrow(
        "Thread nonexistent not found",
      );
    });

    it("reprovisions and accepts tell when thread is provisioning_failed", async () => {
      const input = [{ type: "text" as const, text: "Retry after fixing project path" }];
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "provisioning_failed" }),
      );
      const scheduleProvisioningSpy = vi
        .spyOn(manager as any, "_scheduleProvisioning")
        .mockImplementation(() => {});

      await expect(manager.tell("thread-1", { input })).resolves.toBeUndefined();

      expect(scheduleProvisioningSpy).toHaveBeenCalledWith(
        "thread-1",
        expect.objectContaining({
          projectId: "proj-1",
          input,
        }),
        { reason: "tell-after-provisioning-failure" },
      );
    });

    it("falls back to reprovision when thread/resume fails with missing rollout", async () => {
      const input = [{ type: "text" as const, text: "Retry after resume miss" }];
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "idle" }),
      );
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo as any).getLatestProviderThreadId = vi
        .fn()
        .mockReturnValue("stale-rollout-1");

      const resumeChild = createFakeChildProcess({ autoRespond: false });
      resumeChild.stdin = new Writable({
        write(chunk: Buffer, _encoding: string, callback: () => void) {
          const data = chunk.toString();
          resumeChild._stdinData.push(data);
          try {
            const msg = JSON.parse(data.trim());
            if (msg.method === "thread/resume" && msg.id) {
              process.nextTick(() => {
                resumeChild.stdout!.push(
                  JSON.stringify({
                    id: msg.id,
                    error: {
                      code: -32602,
                      message: "no rollout found for thread id stale-rollout-1",
                    },
                  }) + "\n",
                );
              });
            }
          } catch {}
          callback();
        },
      });

      const reprovisionChild = createFakeChildProcess();
      (spawnMock as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(resumeChild)
        .mockReturnValueOnce(reprovisionChild);

      await expect(manager.tell("thread-1", { input })).resolves.toBeUndefined();

      const resumeMethods = resumeChild._stdinData.map((line) => {
        try {
          return JSON.parse(line.trim()).method as string;
        } catch {
          return "";
        }
      });
      expect(resumeMethods).toContain("thread/resume");

      const reprovisionMethods = reprovisionChild._stdinData.map((line) => {
        try {
          return JSON.parse(line.trim()).method as string;
        } catch {
          return "";
        }
      });
      expect(reprovisionMethods).toContain("thread/start");
      expect(reprovisionMethods).toContain("turn/start");
    });

    it("throws if thread has no active process", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );
      // processes map is empty by default, so no active process

      await expect(
        manager.tell("thread-1", { input: [{ type: "text", text: "hello" }] }),
      ).rejects.toThrow(
        "Thread thread-1 has no codex session",
      );
    });

    it("throws if thread has no codex session", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      // Register a process but no codex thread ID
      const fakeProcess = { kill: vi.fn(), stdin: null, stdout: null, stderr: null };
      (manager as any).processes.set("thread-1", fakeProcess);

      await expect(
        manager.tell("thread-1", { input: [{ type: "text", text: "hello" }] }),
      ).rejects.toThrow(
        "Thread thread-1 has no codex session",
      );
    });

    it("sends turn/start JSON-RPC when thread has an active process and codex session", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      // Manually register a fake process and codex thread ID
      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "codex-tid-123");

      await manager.tell("thread-1", { input: [{ type: "text", text: "Do more work" }] });

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.method).toBe("turn/start");
      expect(msg.params.threadId).toBe("codex-tid-123");
      expect(msg.params.input).toEqual([{ type: "text", text: "Do more work" }]);
      expect(msg.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    });

    it("sends turn/steer JSON-RPC when mode=steer and an active turn exists", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "codex-tid-123");
      (manager as any).activeTurnIds.set("thread-1", "turn-123");

      await manager.tell("thread-1", {
        input: [{ type: "text", text: "Keep going" }],
        mode: "steer",
      });

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.method).toBe("turn/steer");
      expect(msg.params).toEqual({
        threadId: "codex-tid-123",
        expectedTurnId: "turn-123",
        input: [{ type: "text", text: "Keep going" }],
      });
    });

    it("auto mode uses turn/steer when an active turn is known", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "codex-tid-123");
      (manager as any).activeTurnIds.set("thread-1", "turn-123");

      await manager.tell("thread-1", {
        input: [{ type: "text", text: "Keep going" }],
      });

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.method).toBe("turn/steer");
    });

    it("auto mode falls back to turn/start when sandbox override is provided", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "codex-tid-123");
      (manager as any).activeTurnIds.set("thread-1", "turn-123");

      await manager.tell(
        "thread-1",
        {
          input: [{ type: "text", text: "Keep going" }],
        },
        {
          sandboxMode: "read-only",
        },
      );

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.method).toBe("turn/start");
      expect(msg.params.sandboxPolicy).toEqual({ type: "readOnly" });
    });

    it("throws when mode=steer but no active turn exists", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(_chunk: Buffer, _enc: string, cb: () => void) {
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "codex-tid-123");

      await expect(
        manager.tell("thread-1", {
          input: [{ type: "text", text: "Keep going" }],
          mode: "steer",
        }),
      ).rejects.toThrow("Thread thread-1 has no active turn to steer");
    });

    it("throws when mode=steer is used with model/reasoning overrides", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(_chunk: Buffer, _enc: string, cb: () => void) {
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "codex-tid-123");
      (manager as any).activeTurnIds.set("thread-1", "turn-123");

      await expect(
        manager.tell(
          "thread-1",
          {
            input: [{ type: "text", text: "Keep going" }],
            mode: "steer",
          },
          {
            model: "gpt-5-codex",
          },
        ),
      ).rejects.toThrow(
        "Tell mode 'steer' does not support model or reasoning overrides",
      );
    });

    it("sends turn/start with multimodal input payload", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "codex-tid-123");

      await manager.tell("thread-1", {
        input: [
          { type: "text", text: "Analyze these images." },
          { type: "image", url: "https://example.com/mock.png" },
          { type: "localImage", path: "/tmp/mock.png" },
        ],
      });

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.params.input).toEqual([
        { type: "text", text: "Analyze these images." },
        { type: "image", url: "https://example.com/mock.png" },
        { type: "localImage", path: "/tmp/mock.png" },
      ]);
      expect(msg.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    });

    it("throws for empty tell payload object", async () => {
      await expect(manager.tell("thread-1", { input: [] })).rejects.toThrow(
        "Tell payload input must be non-empty",
      );
    });

    it("marks an idle thread as active before turn/start", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "idle" }),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "codex-tid-123");

      await manager.tell("thread-1", { input: [{ type: "text", text: "Continue" }] });

      expect(fakeStdinData.length).toBe(1);
      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", { status: "active" });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", ["status-changed", "work-status-changed"]);
    });

    it("does not derive thread titles from tell input", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "idle" }),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "codex-tid-123");

      await manager.tell("thread-1", {
        input: [{ type: "text", text: "New candidate title text" }],
      });

      expect(threadRepo.update).not.toHaveBeenCalledWith(
        "thread-1",
        expect.objectContaining({
          title: expect.any(String),
        }),
      );
      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "active",
      });
      expect(fakeStdinData.length).toBe(1);
    });

    it("includes model and reasoning config when tell() options are provided", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "codex-tid-123");

      await manager.tell(
        "thread-1",
        { input: [{ type: "text", text: "Do more work" }] },
        {
        model: "gpt-5-codex",
        reasoningLevel: "medium",
        },
      );

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.params.model).toBe("gpt-5-codex");
      expect(msg.params.config).toEqual({
        model_reasoning_effort: "medium",
      });
      expect(msg.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    });

    it("persists outbound tell events with initiator=user metadata", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "codex-tid-123");
      (eventRepo.create as ReturnType<typeof vi.fn>).mockClear();

      await manager.tell(
        "thread-1",
        { input: [{ type: "text", text: "Continue" }] },
        undefined,
        { initiator: "user" },
      );

      expect(fakeStdinData.length).toBe(1);
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          type: "client/turn/start",
          data: expect.objectContaining({
            direction: "outbound",
            source: "tell",
            initiator: "user",
          }),
        }),
      );
    });

    it("persists outbound systemTell events with initiator=system metadata", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "codex-tid-123");
      (eventRepo.create as ReturnType<typeof vi.fn>).mockClear();

      await manager.systemTell("thread-1", {
        input: [{ type: "text", text: "Internal notification" }],
      });

      expect(fakeStdinData.length).toBe(1);
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          type: "client/turn/start",
          data: expect.objectContaining({
            direction: "outbound",
            source: "tell",
            initiator: "system",
          }),
        }),
      );
    });

  });

  describe("stop()", () => {
    it("updates status to idle and broadcasts when no active process", () => {
      manager.stop("thread-1");

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("kills the process with SIGTERM when an active process exists", () => {
      const fakeProcess = { kill: vi.fn(), exitCode: null, stdin: null, stdout: null };
      (manager as any).processes.set("thread-1", fakeProcess);

      manager.stop("thread-1");

      expect(fakeProcess.kill).toHaveBeenCalledWith("SIGTERM");
      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
      });
    });

    it("does not destroy workspace environment on stop", () => {
      const cleanup = vi.fn();
      (manager as any).environmentRuntimes.set("thread-1", {
        adapter: {
          info: {
            id: "worktree",
            displayName: "Git Worktree Workspace",
            description: "",
            capabilities: {
              isolatedFilesystem: true,
              ephemeralWorkspace: true,
              supportsCleanup: true,
            },
          },
          prepare: vi.fn(),
        },
        session: { cwd: "/tmp/worktree", cleanup },
      });

      manager.stop("thread-1");

      expect(cleanup).not.toHaveBeenCalled();
    });
  });

  describe("archive()", () => {
    it("marks a thread archived and broadcasts when no active process", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle" }),
      );

      manager.archive("thread-1");

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
        archivedAt: expect.any(Number),
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
        "archived-changed",
      ]);
    });

    it("kills running process and clears runtime state when archiving", () => {
      const fakeProcess = { kill: vi.fn(), exitCode: null, stdin: null, stdout: null };
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "active" }),
      );
      (manager as any).processes.set("thread-1", fakeProcess);
      (manager as any).providerThreadIds.set("thread-1", "provider-thread-1");
      (manager as any).activeTurnIds.set("thread-1", "turn-1");

      manager.archive("thread-1");

      expect(fakeProcess.kill).toHaveBeenCalledWith("SIGTERM");
      expect((manager as any).processes.has("thread-1")).toBe(false);
      expect((manager as any).providerThreadIds.has("thread-1")).toBe(false);
      expect((manager as any).activeTurnIds.has("thread-1")).toBe(false);
      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
        archivedAt: expect.any(Number),
      });
    });

    it("destroys workspace environment on archive", () => {
      const cleanup = vi.fn();
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle" }),
      );
      (manager as any).environmentRuntimes.set("thread-1", {
        adapter: {
          info: {
            id: "worktree",
            displayName: "Git Worktree Workspace",
            description: "",
            capabilities: {
              isolatedFilesystem: true,
              ephemeralWorkspace: true,
              supportsCleanup: true,
            },
          },
          prepare: vi.fn(),
        },
        session: { cwd: "/tmp/worktree", cleanup },
      });

      manager.archive("thread-1");

      expect(cleanup).toHaveBeenCalledTimes(1);
    });
  });

  describe("unarchive()", () => {
    it("clears archived timestamp and broadcasts", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle", archivedAt: 1234 }),
      );

      manager.unarchive("thread-1");

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        archivedAt: null,
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "archived-changed",
      ]);
    });

    it("does nothing when thread is not archived", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle", archivedAt: undefined }),
      );

      manager.unarchive("thread-1");

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
    });
  });

  describe("tell() archived threads", () => {
    it("rejects tells for archived threads", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle", archivedAt: 1234 }),
      );

      await expect(
        manager.tell("thread-1", {
          input: [{ type: "text", text: "hello" }],
        }),
      ).rejects.toThrow("Thread thread-1 is archived");
    });
  });

  describe("getEvents()", () => {
    it("returns raw persisted events", () => {
      const events = [
        makeEvent({ seq: 1, type: "turn/started", data: { turnId: "turn-1" } }),
        makeEvent({ seq: 2, id: "evt-2", type: "turn/completed", data: { turnId: "turn-1" } }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      const result = manager.getEvents("thread-1", 0);

      expect(result).toEqual(events);
      expect(eventRepo.listByThread).toHaveBeenCalledWith(
        "thread-1",
        0,
        undefined,
      );
    });

    it("passes undefined afterSeq when not provided", () => {
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([]);

      manager.getEvents("thread-1");

      expect(eventRepo.listByThread).toHaveBeenCalledWith(
        "thread-1",
        undefined,
        undefined,
      );
    });
  });

  describe("listModels()", () => {
    it("delegates to the provider adapter", async () => {
      const models = [
        {
          id: "model-a",
          model: "model-a",
          displayName: "Model A",
          description: "",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low effort" },
          ],
          defaultReasoningEffort: "low",
          isDefault: true,
        },
      ];

      const providerListModels = vi.fn().mockResolvedValue(models);
      (manager as any).provider.listModels = providerListModels;

      await expect(manager.listModels()).resolves.toEqual(models);
      expect(providerListModels).toHaveBeenCalledTimes(1);
    });
  });

  describe("getOutput()", () => {
    it("extracts text from last item/completed agentMessage event", () => {
      const events = [
        makeEvent({ seq: 1, type: "turn/started", data: {} }),
        makeEvent({
          seq: 2,
          type: "item/completed",
          data: { item: { type: "agentMessage", text: "Final output" } },
        }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      expect(manager.getOutput("thread-1")).toBe("Final output");
    });

    it("ignores item/completed events that are not agentMessage type", () => {
      const events = [
        makeEvent({
          seq: 1,
          type: "item/completed",
          data: { item: { type: "toolCall", name: "bash" } },
        }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      expect(manager.getOutput("thread-1")).toBeUndefined();
    });

    it("returns undefined if no item/completed events", () => {
      const events = [
        makeEvent({ seq: 1, type: "turn/started", data: {} }),
        makeEvent({ seq: 2, type: "turn/completed", data: {} }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      expect(manager.getOutput("thread-1")).toBeUndefined();
    });

    it("returns undefined for empty events list", () => {
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([]);

      expect(manager.getOutput("thread-1")).toBeUndefined();
    });

    it("returns undefined when item has no text field", () => {
      const events = [
        makeEvent({
          seq: 1,
          type: "item/completed",
          data: { item: { type: "agentMessage" } },
        }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      expect(manager.getOutput("thread-1")).toBeUndefined();
    });

    it("returns undefined when item.text is not a string", () => {
      const events = [
        makeEvent({
          seq: 1,
          type: "item/completed",
          data: { item: { type: "agentMessage", text: 42 } },
        }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      expect(manager.getOutput("thread-1")).toBeUndefined();
    });

    it("returns text from the LAST agentMessage item/completed event when multiple exist", () => {
      const events = [
        makeEvent({
          seq: 1,
          type: "item/completed",
          data: { item: { type: "agentMessage", text: "First output" } },
        }),
        makeEvent({ seq: 2, type: "turn/started", data: {} }),
        makeEvent({
          seq: 3,
          type: "item/completed",
          data: { item: { type: "agentMessage", text: "Latest output" } },
        }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      expect(manager.getOutput("thread-1")).toBe("Latest output");
    });
  });

  describe("getById()", () => {
    it("delegates to threadRepo", () => {
      const thread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      expect(manager.getById("thread-1")).toBe(thread);
      expect(threadRepo.getById).toHaveBeenCalledWith("thread-1");
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("returns undefined for nonexistent thread", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      expect(manager.getById("nonexistent")).toBeUndefined();
    });

    it("includes prompt-derived title fallback when persisted title is missing", () => {
      const untitledThread = makeThread({ status: "idle", title: undefined });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(untitledThread);
      (eventRepo.getLatestByType as ReturnType<typeof vi.fn>).mockReturnValue(
        makeEvent({
          type: "client/thread/start",
          data: {
            input: [{ type: "text", text: "Investigate flaky test reruns" }],
          },
        }),
      );

      const result = manager.getById("thread-1");
      const resultSecondRead = manager.getById("thread-1");

      expect(result?.title).toBeUndefined();
      expect(result?.titleFallback).toBe("Investigate flaky test reruns");
      expect(resultSecondRead?.titleFallback).toBe("Investigate flaky test reruns");
      expect(eventRepo.getLatestByType).toHaveBeenCalledTimes(1);
    });

    it("returns persisted active status even when lifecycle events suggest completion", () => {
      const runningThread = makeThread({ status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(runningThread);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/started", data: {} }),
        makeEvent({ seq: 2, type: "turn/completed", data: {} }),
      ]);
      const result = manager.getById("thread-1");

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result?.status).toBe("active");
    });

    it("reconciles idle thread to idle when latest turn is started but no process exists", () => {
      const idleThread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(idleThread);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/completed", data: {} }),
        makeEvent({ seq: 2, type: "turn/started", data: {} }),
      ]);
      const result = manager.getById("thread-1");

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result?.status).toBe("idle");
    });

    it("returns persisted idle status even when process exists and lifecycle events started", () => {
      const idleThread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(idleThread);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/completed", data: {} }),
        makeEvent({ seq: 2, type: "turn/started", data: {} }),
      ]);
      (manager as any).processes.set("thread-1", { kill: vi.fn(), stdin: null, stdout: null });

      const result = manager.getById("thread-1");

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result?.status).toBe("idle");
    });
  });

  describe("list()", () => {
    it("delegates to threadRepo with filters", () => {
      const threads = [makeThread({ status: "idle" })];
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue(threads);

      const filters = { projectId: "proj-1" };
      const result = manager.list(filters);

      expect(result).toStrictEqual(threads);
      expect(threadRepo.list).toHaveBeenCalledWith(filters);
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("includes prompt-derived title fallback for untitled threads", () => {
      const threads = [makeThread({ id: "thread-1", status: "idle", title: undefined })];
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue(threads);
      (eventRepo.getLatestByType as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, type: string) =>
          type === "client/thread/start"
            ? makeEvent({
                type: "client/thread/start",
                data: {
                  input: [{ type: "text", text: "Stabilize flaky auth redirect tests" }],
                },
              })
            : undefined,
      );

      const result = manager.list();
      const secondResult = manager.list();

      expect(result[0]?.title).toBeUndefined();
      expect(result[0]?.titleFallback).toBe("Stabilize flaky auth redirect tests");
      expect(secondResult[0]?.titleFallback).toBe("Stabilize flaky auth redirect tests");
      expect(eventRepo.getLatestByType).toHaveBeenCalledTimes(1);
    });

    it("returns persisted active list status even when lifecycle events suggest completion", () => {
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "thread-1", status: "active" }),
      ]);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/completed", data: {} }),
      ]);
      const result = manager.list();

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result[0]?.status).toBe("active");
    });

    it("reconciles idle threads to idle when latest turn is started but no process exists", () => {
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "thread-1", status: "idle" }),
      ]);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/completed", data: {} }),
        makeEvent({ seq: 2, type: "turn/started", data: {} }),
      ]);
      const result = manager.list();

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result[0]?.status).toBe("idle");
    });

    it("returns persisted idle list status even when process exists and lifecycle events started", () => {
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "thread-1", status: "idle" }),
      ]);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/completed", data: {} }),
        makeEvent({ seq: 2, type: "turn/started", data: {} }),
      ]);
      (manager as any).processes.set("thread-1", { kill: vi.fn(), stdin: null, stdout: null });

      const result = manager.list();

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result[0]?.status).toBe("idle");
    });
  });

  describe("isActive()", () => {
    it("returns false when no process registered", () => {
      expect(manager.isActive("thread-1")).toBe(false);
    });
  });

  describe("getActiveCount()", () => {
    it("returns 0 when no processes are active", () => {
      expect(manager.getActiveCount()).toBe(0);
    });
  });

  describe("getRunningCount()", () => {
    it("returns active count from persisted DB status", () => {
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "t-1", status: "active" }),
        makeThread({ id: "t-2", status: "active" }),
      ]);
      (manager as any).processes.set("t-1", { kill: vi.fn(), stdin: null, stdout: null });
      (manager as any).processes.set("t-2", { kill: vi.fn(), stdin: null, stdout: null });

      expect(manager.getRunningCount()).toBe(2);
      expect(threadRepo.list).toHaveBeenCalledWith({ status: "active" });
    });

    it("treats stale persisted active rows as active until explicitly updated", () => {
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "t-1", status: "active" }),
      ]);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, threadId: "t-1", type: "turn/started", data: {} }),
      ]);

      expect(manager.getRunningCount()).toBe(1);
    });
  });

  describe("worktree operation broadcasts", () => {
    it("passes includeUnstaged to provider commit-message generation", async () => {
      const providerCommitMessageGenerator = vi.fn().mockResolvedValue("feat: generated message");
      const autogenManager = new ThreadManager(
        threadRepo as any,
        eventRepo as any,
        projectRepo as any,
        ws as any,
        createCodexProviderAdapter({ commitMessageGenerator: providerCommitMessageGenerator }),
      );
      const thread = makeThread({
        id: "thread-1",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
      (eventRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(
        makeEvent({ seq: 1, type: "system/worktree/commit" }),
      );

      (autogenManager as any).gitStatusService = {
        detectDefaultBranch: vi.fn().mockReturnValue("main"),
        commit: vi.fn().mockReturnValue({
          ok: true,
          commitCreated: true,
          message: "Committed",
          commitSha: "abc123",
        }),
      };

      await autogenManager.commitThread("thread-1", { includeUnstaged: false });

      expect(providerCommitMessageGenerator).toHaveBeenCalledWith({
        cwd: "/tmp/proj-1",
        includeUnstaged: false,
      });
    });

    it("throws when auto commit-message generation fails", async () => {
      const autogenManager = new ThreadManager(
        threadRepo as any,
        eventRepo as any,
        projectRepo as any,
        ws as any,
        createCodexProviderAdapter({ commitMessageGenerator: vi.fn().mockResolvedValue(undefined) }),
      );
      const thread = makeThread({
        id: "thread-1",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (autogenManager as any).gitStatusService = {
        detectDefaultBranch: vi.fn().mockReturnValue("main"),
        commit: vi.fn(),
      };

      await expect(
        autogenManager.commitThread("thread-1", { includeUnstaged: true }),
      ).rejects.toThrow("Failed to auto-generate commit message");
    });

    it("broadcasts events-appended after commitThread appends a system event", async () => {
      const thread = makeThread({
        id: "thread-1",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
      (eventRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(
        makeEvent({ seq: 1, type: "system/worktree/commit" }),
      );

      (manager as any).gitStatusService = {
        detectDefaultBranch: vi.fn().mockReturnValue("main"),
        commit: vi.fn().mockReturnValue({
          ok: true,
          commitCreated: true,
          message: "Committed",
          commitSha: "abc123",
        }),
        invalidate: vi.fn(),
      };

      await manager.commitThread("thread-1", { message: "test commit" });

      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "events-appended",
        "work-status-changed",
      ]);
    });

    it("broadcasts events-appended after squashMergeThread appends a system event", async () => {
      const thread = makeThread({
        id: "thread-1",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
      (eventRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(
        makeEvent({ seq: 1, type: "system/worktree/squash_merge" }),
      );

      (manager as any).gitStatusService = {
        detectDefaultBranch: vi.fn().mockReturnValue("main"),
        getStatus: vi
          .fn()
          .mockReturnValueOnce({ hasUncommittedChanges: false })
          .mockReturnValueOnce({ hasUncommittedChanges: false }),
        squashMergeWorktreeIntoDefaultBranch: vi.fn().mockReturnValue({
          merged: true,
          message: "Squash-merged into main",
        }),
        invalidate: vi.fn(),
      };

      await manager.squashMergeThread("thread-1");

      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "events-appended",
        "work-status-changed",
      ]);
    });

    it("uses the requested merge base branch for squash merge", async () => {
      const thread = makeThread({
        id: "thread-1",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
      (eventRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(
        makeEvent({ seq: 1, type: "system/worktree/squash_merge" }),
      );

      const getStatus = vi
        .fn()
        .mockReturnValueOnce({
          hasUncommittedChanges: false,
          mergeBaseBranch: "release",
        })
        .mockReturnValueOnce({
          hasUncommittedChanges: false,
          mergeBaseBranch: "release",
        });
      const squashMergeWorktreeIntoDefaultBranch = vi.fn().mockReturnValue({
        merged: true,
        message: "Squash-merged into release",
      });

      (manager as any).gitStatusService = {
        detectDefaultBranch: vi.fn().mockReturnValue("main"),
        getStatus,
        squashMergeWorktreeIntoDefaultBranch,
        invalidate: vi.fn(),
      };

      await manager.squashMergeThread("thread-1", { mergeBaseBranch: "release" });

      expect(getStatus).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          defaultBranch: "main",
          mergeBaseBranch: "release",
        }),
      );
      expect(squashMergeWorktreeIntoDefaultBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultBranch: "release",
        }),
      );
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            mergeBaseBranch: "release",
          }),
        }),
      );
    });

    it("auto-archives local threads after a successful commit by default", async () => {
      const thread = makeThread({
        id: "thread-1",
        status: "idle",
        environmentId: "local",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
      (eventRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(
        makeEvent({ seq: 1, type: "system/worktree/commit" }),
      );

      (manager as any).gitStatusService = {
        detectDefaultBranch: vi.fn().mockReturnValue("main"),
        commit: vi.fn().mockReturnValue({
          ok: true,
          commitCreated: true,
          message: "Committed",
          commitSha: "abc123",
        }),
        invalidate: vi.fn(),
      };

      await manager.commitThread("thread-1", { message: "test commit" });

      expect(threadRepo.update).toHaveBeenCalledWith(
        "thread-1",
        expect.objectContaining({
          status: "idle",
          archivedAt: expect.any(Number),
        }),
      );
    });

    it("does not auto-archive local threads when request setting is disabled", async () => {
      const thread = makeThread({
        id: "thread-1",
        status: "idle",
        environmentId: "local",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
      (eventRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(
        makeEvent({ seq: 1, type: "system/worktree/commit" }),
      );

      (manager as any).gitStatusService = {
        detectDefaultBranch: vi.fn().mockReturnValue("main"),
        commit: vi.fn().mockReturnValue({
          ok: true,
          commitCreated: true,
          message: "Committed",
          commitSha: "abc123",
        }),
      };

      await manager.commitThread("thread-1", {
        message: "test commit",
        autoArchiveThreadOnCommit: false,
      });

      expect(threadRepo.update).not.toHaveBeenCalledWith(
        "thread-1",
        expect.objectContaining({
          archivedAt: expect.any(Number),
        }),
      );
    });

    it("auto-archives worktree threads after successful squash merge", async () => {
      const thread = makeThread({
        id: "thread-1",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
      (eventRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(
        makeEvent({ seq: 1, type: "system/worktree/squash_merge" }),
      );

      (manager as any).gitStatusService = {
        detectDefaultBranch: vi.fn().mockReturnValue("main"),
        getStatus: vi
          .fn()
          .mockReturnValueOnce({ hasUncommittedChanges: false })
          .mockReturnValueOnce({ hasUncommittedChanges: false }),
        squashMergeWorktreeIntoDefaultBranch: vi.fn().mockReturnValue({
          merged: true,
          message: "Squash-merged into main",
        }),
        invalidate: vi.fn(),
      };

      await manager.squashMergeThread("thread-1");

      expect(threadRepo.update).toHaveBeenCalledWith(
        "thread-1",
        expect.objectContaining({
          status: "idle",
          archivedAt: expect.any(Number),
        }),
      );
    });
  });

  describe("stopAll()", () => {
    it("clears all processes and is safe to call when empty", () => {
      // Should not throw when no processes
      manager.stopAll();
      expect(manager.getActiveCount()).toBe(0);
    });

    it("kills all active processes and marks them idle", () => {
      const proc1 = { kill: vi.fn(), stdin: null, stdout: null };
      const proc2 = { kill: vi.fn(), stdin: null, stdout: null };
      (manager as any).processes.set("thread-1", proc1);
      (manager as any).processes.set("thread-2", proc2);

      expect(manager.getActiveCount()).toBe(2);

      manager.stopAll();

      expect(proc1.kill).toHaveBeenCalledWith("SIGTERM");
      expect(proc2.kill).toHaveBeenCalledWith("SIGTERM");
      expect(threadRepo.update).toHaveBeenCalledWith(
        "thread-1",
        { status: "idle" },
        { touchUpdatedAt: false },
      );
      expect(threadRepo.update).toHaveBeenCalledWith(
        "thread-2",
        { status: "idle" },
        { touchUpdatedAt: false },
      );
      expect(manager.getActiveCount()).toBe(0);
    });
  });

  describe("_handleProcessExit()", () => {
    // Access private method for testing
    it("sets idle on exit code 0", () => {
      const thread = makeThread({ status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      // Call private method via bracket notation
      (manager as any)._handleProcessExit("thread-1", 0, null);

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("sets idle on SIGTERM signal", () => {
      const thread = makeThread({ status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      (manager as any)._handleProcessExit("thread-1", null, "SIGTERM");

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
      });
    });

    it("sets idle on non-zero exit code", () => {
      const thread = makeThread({ status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      (manager as any)._handleProcessExit("thread-1", 1, null);

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("does not update status on exit code 0 when thread is already idle", () => {
      const thread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      (manager as any)._handleProcessExit("thread-1", 0, null);

      expect(threadRepo.update).not.toHaveBeenCalled();
    });

    it("does not update status on non-zero exit when thread is already idle", () => {
      const thread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      (manager as any)._handleProcessExit("thread-1", 1, null);

      expect(threadRepo.update).not.toHaveBeenCalled();
    });

    it("does not update status if thread is already idle", () => {
      const thread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      (manager as any)._handleProcessExit("thread-1", 0, null);

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("does nothing if thread not found in DB", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      (manager as any)._handleProcessExit("thread-1", 0, null);

      expect(threadRepo.update).not.toHaveBeenCalled();
      // Should not broadcast
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("removes process from the internal map", () => {
      // Manually add a fake process to the internal map
      const fakeProcess = { kill: vi.fn(), stdin: null, stdout: null };
      (manager as any).processes.set("thread-1", fakeProcess);
      expect(manager.isActive("thread-1")).toBe(true);

      const thread = makeThread({ status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      (manager as any)._handleProcessExit("thread-1", 0, null);

      expect(manager.isActive("thread-1")).toBe(false);
    });
  });

  describe("getTimeline()", () => {
    it("includes provider thread/name/updated rows in the projected timeline", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "idle" }),
      );
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(1);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({
          seq: 1,
          type: "thread/name/updated",
          data: {
            threadId: "provider-thread-1",
            threadName: "Renamed by agent",
          },
        }),
      ]);

      const timeline = manager.getTimeline("thread-1");
      const rows = timeline.rows.filter(
        (row): row is Extract<(typeof timeline.rows)[number], { kind: "message" }> =>
          row.kind === "message",
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.message.kind).toBe("operation");
      if (rows[0]?.message.kind !== "operation") return;
      expect(rows[0].message.opType).toBe("thread-title-updated");
      expect(rows[0].message.detail).toBe("Renamed by agent");

      const ignoredTypes = (eventRepo.listByThread as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[3] as readonly string[] | undefined;
      expect(ignoredTypes).toBeDefined();
      expect(ignoredTypes).not.toContain("thread/name/updated");
    });

    it("includes compaction rows in the projected timeline", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "idle" }),
      );
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(1);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({
          seq: 1,
          type: "thread/compacted",
          data: {
            threadId: "provider-thread-1",
            turnId: "turn-1",
          },
        }),
      ]);

      const timeline = manager.getTimeline("thread-1");
      const rows = timeline.rows.filter(
        (row): row is Extract<(typeof timeline.rows)[number], { kind: "message" }> =>
          row.kind === "message",
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.message.kind).toBe("operation");
      if (rows[0]?.message.kind !== "operation") return;
      expect(rows[0].message.opType).toBe("compaction");
      expect(rows[0].message.title).toBe("Context compacted");
    });
  });
});

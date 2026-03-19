import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Thread } from "@bb/core";
import type {
  EnvironmentAgentSessionRepository,
  ProjectRepository,
  ThreadRepository,
} from "@bb/db";
import { createSystemHealthReporter } from "../system-health-report.js";

const originalHome = process.env.HOME;
const originalBbRoot = process.env.BB_ROOT;
const cleanupPaths: string[] = [];

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "Project 1",
    rootPath: "/tmp/project-1",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "proj-1",
    providerId: "codex",
    type: "standard",
    status: "idle",
    createdAt: 1000,
    updatedAt: 1000,
    lastReadAt: 1000,
    ...overrides,
  } as Thread;
}

function writeBytes(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.BB_ROOT = originalBbRoot;
  vi.restoreAllMocks();
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("system health report", () => {
  it("summarizes thread counts and managed storage buckets", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "bb-health-home-"));
    cleanupPaths.push(homeDir);
    process.env.HOME = homeDir;
    const bbRoot = mkdtempSync(join(tmpdir(), "bb-health-root-"));
    cleanupPaths.push(bbRoot);
    process.env.BB_ROOT = bbRoot;

    const projectRoot = mkdtempSync(join(tmpdir(), "bb-health-project-"));
    cleanupPaths.push(projectRoot);
    const dbPath = resolve(bbRoot, "bb.db");
    const serverLogPath = resolve(bbRoot, "logs", "server.log");

    writeBytes(dbPath, "db!");
    writeBytes(`${dbPath}-wal`, "wal!");
    writeBytes(`${dbPath}-shm`, "shm");
    writeBytes(serverLogPath, "server");
    writeBytes(`${serverLogPath}.1`, "archive");
    writeBytes(resolve(bbRoot, "environment-agent-logs", "proj-1", "worktree-thread-1.log"), "envlog");
    writeBytes(resolve(bbRoot, "worktrees", "proj-1", "thread-1", "README.md"), "workspace");
    writeBytes(resolve(bbRoot, "attachments", "proj-1", "image.png"), "img");
    writeBytes(resolve(bbRoot, "backups", "daily.sql"), "backup");

    const project = makeProject({ rootPath: projectRoot });
    const threads = [
      makeThread({ id: "thread-1", status: "active", environmentId: "env-worktree-1" }),
      makeThread({ id: "thread-2", status: "idle", archivedAt: 2_000 }),
      makeThread({ id: "thread-3", status: "provisioning" }),
    ];
    const now = 1_700_000_000_000;
    const projectRepo = {
      list: () => [project],
    } as unknown as ProjectRepository;
    const threadRepo = {
      list: () => threads,
    } as unknown as ThreadRepository;
    const environmentAgentSessionRepo = {
      listActive: () => [
        {
          id: "session-1",
          environmentId: "env-worktree-1",
          agentId: "environment-agent:thread-1",
          agentInstanceId: "instance-1",
          protocolVersion: 1,
          workerName: "environment-daemon",
          workerVersion: "0.0.1",
          workerBuildId: "build-123",
          providerMetadata: [{ providerId: "codex", adapterVersion: "0.0.1" }],
          selectedCapabilities: {
            commands: [
              "provider.ensure",
              "thread.start",
              "thread.resume",
              "turn.run",
            ],
            features: ["worker_metadata", "provider_metadata"],
          },
          controlBaseUrl: "http://127.0.0.1:4321",
          status: "active",
          leaseExpiresAt: now + 45_000,
          lastHeartbeatAt: now - 5_000,
          createdAt: now - 30_000,
          updatedAt: now - 1_000,
        },
      ],
    } as unknown as EnvironmentAgentSessionRepository;

    vi.spyOn(Date, "now").mockReturnValue(now);

    const report = createSystemHealthReporter({
      projectRepo,
      threadRepo,
      environmentAgentSessionRepo,
      getRunningCount: () => 1,
      startTime: now - 3_600_000,
      dbPath,
      serverLogFilePath: serverLogPath,
      runtimeEnv: process.env,
    })();

    expect(report.uptime).toBe(3600);
    expect(report.projectCount).toBe(1);
    expect(report.runningThreads).toBe(1);
    expect(report.threadCounts).toEqual({
      total: 3,
      archived: 1,
      created: 0,
      provisioning: 1,
      provisioned: 0,
      provisioningFailed: 0,
      error: 0,
      active: 1,
      idle: 1,
    });
    expect(report.environmentAgent).toEqual({
      activeSessionCount: 1,
      activeSessions: [
        {
          sessionId: "session-1",
          environmentId: "env-worktree-1",
          agentId: "environment-agent:thread-1",
          agentInstanceId: "instance-1",
          protocolVersion: 1,
          worker: {
            name: "environment-daemon",
            version: "0.0.1",
            buildId: "build-123",
          },
          providers: [{ providerId: "codex", adapterVersion: "0.0.1" }],
          selectedCapabilities: {
            commands: [
              "provider.ensure",
              "thread.start",
              "thread.resume",
              "turn.run",
            ],
            features: ["worker_metadata", "provider_metadata"],
          },
          compatibility: {
            disposition: "degrade",
            missingRequiredCommands: [],
            missingOptionalCommands: [
              "thread.rename",
              "provider.list_catalog",
              "workspace.status",
              "workspace.diff",
            ],
            missingOptionalFeatures: [
              "provider_runtime_version",
              "control_endpoint",
            ],
          },
          controlBaseUrl: "http://127.0.0.1:4321",
          leaseExpiresAt: now + 45_000,
          lastHeartbeatAt: now - 5_000,
          createdAt: now - 30_000,
          updatedAt: now - 1_000,
        },
      ],
    });

    expect(report.storage.totalBytes).toBe(47);
    expect(report.storage.buckets).toEqual([
      {
        key: "database",
        label: "Database",
        bytes: 3,
        paths: [dbPath],
      },
      {
        key: "database_wal",
        label: "Database WAL",
        bytes: 4,
        paths: [`${dbPath}-wal`],
      },
      {
        key: "database_shm",
        label: "Database SHM",
        bytes: 3,
        paths: [`${dbPath}-shm`],
      },
      {
        key: "server_logs",
        label: "Server Logs",
        bytes: 13,
        paths: [serverLogPath, `${serverLogPath}.1`],
      },
      {
        key: "environment_agent_logs",
        label: "Environment Agent Logs",
        bytes: 6,
        paths: [resolve(bbRoot, "environment-agent-logs")],
      },
      {
        key: "worktrees",
        label: "Worktrees",
        bytes: 9,
        paths: [resolve(bbRoot, "worktrees")],
      },
      {
        key: "attachments",
        label: "Attachments",
        bytes: 3,
        paths: [resolve(bbRoot, "attachments")],
      },
      {
        key: "backups",
        label: "Backups",
        bytes: 6,
        paths: [resolve(bbRoot, "backups")],
      },
    ]);
    expect(report.storage.disk?.path).toBe(bbRoot);
    expect(report.storage.disk?.availableBytes).toBeGreaterThan(0);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Thread } from "@beanbag/agent-core";
import type { ProjectRepository, ThreadRepository } from "@beanbag/db";
import { createSystemHealthReporter } from "../system-health-report.js";

const originalHome = process.env.HOME;
const originalBeanbagRoot = process.env.BEANBAG_ROOT;
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
  process.env.BEANBAG_ROOT = originalBeanbagRoot;
  vi.restoreAllMocks();
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("system health report", () => {
  it("summarizes thread counts and managed storage buckets", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "beanbag-health-home-"));
    cleanupPaths.push(homeDir);
    process.env.HOME = homeDir;
    const beanbagRoot = mkdtempSync(join(tmpdir(), "beanbag-health-root-"));
    cleanupPaths.push(beanbagRoot);
    process.env.BEANBAG_ROOT = beanbagRoot;

    const projectRoot = mkdtempSync(join(tmpdir(), "beanbag-health-project-"));
    cleanupPaths.push(projectRoot);
    const dbPath = resolve(beanbagRoot, "beanbag.db");
    const daemonLogPath = resolve(beanbagRoot, "logs", "daemon.log");

    writeBytes(dbPath, "db!");
    writeBytes(`${dbPath}-wal`, "wal!");
    writeBytes(`${dbPath}-shm`, "shm");
    writeBytes(daemonLogPath, "daemon");
    writeBytes(`${daemonLogPath}.1`, "archive");
    writeBytes(resolve(beanbagRoot, "environment-agent-logs", "proj-1", "worktree-thread-1.log"), "envlog");
    writeBytes(resolve(beanbagRoot, "worktrees", "proj-1", "thread-1", "README.md"), "workspace");
    writeBytes(resolve(beanbagRoot, "attachments", "proj-1", "image.png"), "img");
    writeBytes(resolve(beanbagRoot, "backups", "daily.sql"), "backup");

    const project = makeProject({ rootPath: projectRoot });
    const threads = [
      makeThread({ id: "thread-1", status: "active", environmentId: "worktree" }),
      makeThread({ id: "thread-2", status: "idle", archivedAt: 2_000 }),
      makeThread({ id: "thread-3", status: "provisioning" }),
    ];
    const projectRepo = {
      list: () => [project],
    } as unknown as ProjectRepository;
    const threadRepo = {
      list: () => threads,
    } as unknown as ThreadRepository;

    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const report = createSystemHealthReporter({
      projectRepo,
      threadRepo,
      getRunningCount: () => 1,
      startTime: now - 3_600_000,
      dbPath,
      daemonLogFilePath: daemonLogPath,
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
        key: "daemon_logs",
        label: "Daemon Logs",
        bytes: 13,
        paths: [daemonLogPath, `${daemonLogPath}.1`],
      },
      {
        key: "environment_agent_logs",
        label: "Environment Agent Logs",
        bytes: 6,
        paths: [resolve(beanbagRoot, "environment-agent-logs")],
      },
      {
        key: "worktrees",
        label: "Worktrees",
        bytes: 9,
        paths: [resolve(beanbagRoot, "worktrees")],
      },
      {
        key: "attachments",
        label: "Attachments",
        bytes: 3,
        paths: [resolve(beanbagRoot, "attachments")],
      },
      {
        key: "backups",
        label: "Backups",
        bytes: 6,
        paths: [resolve(beanbagRoot, "backups")],
      },
    ]);
    expect(report.storage.disk?.path).toBe(beanbagRoot);
    expect(report.storage.disk?.availableBytes).toBeGreaterThan(0);
  });
});

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, Thread } from "@beanbag/agent-core";
import {
  reconcileManagedArtifactStorage,
} from "../managed-artifact-reconciler.js";
import {
  resolveDefaultEnvironmentAgentLogFilePath,
} from "@beanbag/environment-agent";
import {
  resolveManagedEnvironmentAgentStateFilePaths,
} from "../managed-storage-paths.js";

const originalHome = process.env.HOME;
const cleanupPaths: string[] = [];

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "Project",
    rootPath: "/tmp/project-root",
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

function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

afterEach(() => {
  process.env.HOME = originalHome;
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("managed artifact reconciler", () => {
  it("retains recent archived logs but removes expired and orphaned log artifacts", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "beanbag-reconcile-home-"));
    cleanupPaths.push(homeDir);
    process.env.HOME = homeDir;
    const now = Date.now();
    const retentionMs = 3 * 24 * 60 * 60 * 1000;

    const liveThread = makeThread({
      id: "live-thread",
      environmentId: "worktree",
    });
    const recentArchivedThread = makeThread({
      id: "recent-archived",
      environmentId: "worktree",
      archivedAt: now - (retentionMs / 2),
    });
    const expiredArchivedThread = makeThread({
      id: "expired-archived",
      environmentId: "worktree",
      archivedAt: now - retentionMs - 1,
    });

    const liveLogPath = resolveDefaultEnvironmentAgentLogFilePath({
      projectId: "proj-1",
      threadId: liveThread.id,
      environmentId: "worktree",
    });
    const recentLogPath = resolveDefaultEnvironmentAgentLogFilePath({
      projectId: "proj-1",
      threadId: recentArchivedThread.id,
      environmentId: "worktree",
    });
    const expiredLogPath = resolveDefaultEnvironmentAgentLogFilePath({
      projectId: "proj-1",
      threadId: expiredArchivedThread.id,
      environmentId: "worktree",
    });
    const orphanLogPath = resolveDefaultEnvironmentAgentLogFilePath({
      projectId: "proj-1",
      threadId: "orphan-thread",
      environmentId: "worktree",
    });

    writeTextFile(liveLogPath, "live\n");
    writeTextFile(recentLogPath, "recent\n");
    writeTextFile(expiredLogPath, "expired\n");
    writeTextFile(`${expiredLogPath}.1`, "expired-1\n");
    writeTextFile(orphanLogPath, "orphan\n");

    const project = makeProject({
      id: "proj-1",
      rootPath: mkdtempSync(join(tmpdir(), "beanbag-project-root-")),
    });
    cleanupPaths.push(project.rootPath);

    const result = reconcileManagedArtifactStorage({
      threads: [liveThread, recentArchivedThread, expiredArchivedThread],
      projects: [project],
      runtimeEnv: process.env,
      now,
      archivedLogRetentionMs: retentionMs,
    });

    expect(result.removedLogArtifacts).toBe(2);
    expect(existsSync(liveLogPath)).toBe(true);
    expect(existsSync(recentLogPath)).toBe(true);
    expect(existsSync(expiredLogPath)).toBe(false);
    expect(existsSync(`${expiredLogPath}.1`)).toBe(false);
    expect(existsSync(orphanLogPath)).toBe(false);
  });

  it("removes orphaned env-agent state and stale managed worktrees", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "beanbag-reconcile-home-"));
    cleanupPaths.push(homeDir);
    process.env.HOME = homeDir;

    const projectRoot = mkdtempSync(join(tmpdir(), "beanbag-project-root-"));
    cleanupPaths.push(projectRoot);
    const project = makeProject({
      id: "proj-1",
      rootPath: projectRoot,
    });
    const liveThread = makeThread({
      id: "live-thread",
      environmentId: "worktree",
    });
    const archivedThread = makeThread({
      id: "archived-thread",
      environmentId: "worktree",
      archivedAt: Date.now() - 1_000,
    });

    const liveStatePaths = resolveManagedEnvironmentAgentStateFilePaths({
      thread: liveThread,
      project,
      runtimeEnv: process.env,
    });
    const archivedStatePaths = resolveManagedEnvironmentAgentStateFilePaths({
      thread: archivedThread,
      project,
      runtimeEnv: process.env,
    });
    const stateRoot = resolve(homeDir, ".beanbag", "environment-agents", "proj-1");
    for (const statePath of liveStatePaths) {
      writeTextFile(statePath, "{}");
    }
    for (const statePath of archivedStatePaths) {
      writeTextFile(statePath, "{}");
    }
    const orphanStatePath = join(stateRoot, "worktree-orphan-thread.json");
    writeTextFile(orphanStatePath, "{}");

    const worktreeRoot = resolve(homeDir, ".beanbag", "worktrees", "proj-1");
    mkdirSync(join(worktreeRoot, "live-thread"), { recursive: true });
    mkdirSync(join(worktreeRoot, "archived-thread"), { recursive: true });
    mkdirSync(join(worktreeRoot, "orphan-thread"), { recursive: true });
    mkdirSync(resolve(homeDir, ".beanbag", "worktrees", "orphan-project", "thread-1"), {
      recursive: true,
    });

    const result = reconcileManagedArtifactStorage({
      threads: [liveThread, archivedThread],
      projects: [project],
      runtimeEnv: process.env,
      now: Date.now(),
      archivedLogRetentionMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(result.removedStateFiles).toBe(archivedStatePaths.length + 1);
    expect(result.removedWorkspaceDirectories).toBe(3);
    for (const statePath of liveStatePaths) {
      expect(existsSync(statePath)).toBe(true);
    }
    for (const statePath of archivedStatePaths) {
      expect(existsSync(statePath)).toBe(false);
    }
    expect(existsSync(orphanStatePath)).toBe(false);
    expect(existsSync(join(worktreeRoot, "live-thread"))).toBe(true);
    expect(existsSync(join(worktreeRoot, "archived-thread"))).toBe(false);
    expect(existsSync(join(worktreeRoot, "orphan-thread"))).toBe(false);
    expect(existsSync(resolve(homeDir, ".beanbag", "worktrees", "orphan-project"))).toBe(false);
  });
});

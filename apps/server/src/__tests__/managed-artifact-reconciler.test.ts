import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, Thread } from "@bb/core";
import {
  reconcileManagedArtifactStorage,
} from "../managed-artifact-reconciler.js";
import {
  resolveDefaultEnvironmentAgentLogFilePath,
} from "@bb/environment-daemon";

const originalHome = process.env.HOME;
const originalBbRoot = process.env.BB_ROOT;
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
    providerId: "codex",
    type: "standard",
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
  process.env.BB_ROOT = originalBbRoot;
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("managed artifact reconciler", () => {
  it("retains recent archived logs but removes expired and orphaned log artifacts", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "bb-reconcile-home-"));
    cleanupPaths.push(homeDir);
    process.env.HOME = homeDir;
    const bbRoot = mkdtempSync(join(tmpdir(), "bb-reconcile-root-"));
    cleanupPaths.push(bbRoot);
    process.env.BB_ROOT = bbRoot;
    const now = Date.now();
    const retentionMs = 3 * 24 * 60 * 60 * 1000;

    const liveThread = makeThread({
      id: "live-thread",
      environmentId: "env-worktree-1",
    });
    const recentArchivedThread = makeThread({
      id: "recent-archived",
      environmentId: "env-worktree-1",
      archivedAt: now - (retentionMs / 2),
    });
    const expiredArchivedThread = makeThread({
      id: "expired-archived",
      environmentId: "env-worktree-1",
      archivedAt: now - retentionMs - 1,
    });

    const liveLogPath = resolveDefaultEnvironmentAgentLogFilePath({
      projectId: "proj-1",
      threadId: liveThread.id,
      environmentId: "env-worktree-1",
      runtimeEnv: process.env,
    });
    const recentLogPath = resolveDefaultEnvironmentAgentLogFilePath({
      projectId: "proj-1",
      threadId: recentArchivedThread.id,
      environmentId: "env-worktree-1",
      runtimeEnv: process.env,
    });
    const expiredLogPath = resolveDefaultEnvironmentAgentLogFilePath({
      projectId: "proj-1",
      threadId: expiredArchivedThread.id,
      environmentId: "env-worktree-1",
      runtimeEnv: process.env,
    });
    const orphanLogPath = resolveDefaultEnvironmentAgentLogFilePath({
      projectId: "proj-1",
      threadId: "orphan-thread",
      environmentId: "env-worktree-1",
      runtimeEnv: process.env,
    });

    writeTextFile(liveLogPath, "live\n");
    writeTextFile(recentLogPath, "recent\n");
    writeTextFile(expiredLogPath, "expired\n");
    writeTextFile(`${expiredLogPath}.1`, "expired-1\n");
    writeTextFile(orphanLogPath, "orphan\n");

    const project = makeProject({
      id: "proj-1",
      rootPath: mkdtempSync(join(tmpdir(), "bb-project-root-")),
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

  it("removes stale managed worktrees", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "bb-reconcile-home-"));
    cleanupPaths.push(homeDir);
    process.env.HOME = homeDir;
    const bbRoot = mkdtempSync(join(tmpdir(), "bb-reconcile-root-"));
    cleanupPaths.push(bbRoot);
    process.env.BB_ROOT = bbRoot;

    const projectRoot = mkdtempSync(join(tmpdir(), "bb-project-root-"));
    cleanupPaths.push(projectRoot);
    const project = makeProject({
      id: "proj-1",
      rootPath: projectRoot,
    });
    const liveThread = makeThread({
      id: "live-thread",
      environmentId: "env-worktree-1",
    });
    const archivedThread = makeThread({
      id: "archived-thread",
      environmentId: "env-worktree-1",
      archivedAt: Date.now() - 1_000,
    });
    const worktreeRoot = resolve(bbRoot, "worktrees", "proj-1");
    const liveWorkspacePath = join(worktreeRoot, "live-shared-env");
    const archivedWorkspacePath = join(worktreeRoot, "archived-shared-env");

    mkdirSync(liveWorkspacePath, { recursive: true });
    mkdirSync(archivedWorkspacePath, { recursive: true });
    mkdirSync(join(worktreeRoot, "orphan-thread"), { recursive: true });
    mkdirSync(resolve(bbRoot, "worktrees", "orphan-project", "thread-1"), {
      recursive: true,
    });

    const result = reconcileManagedArtifactStorage({
      threads: [liveThread, archivedThread],
      environments: [
        {
          id: "env-live",
          projectId: "proj-1",
          descriptor: {
            type: "path",
            path: liveWorkspacePath,
          },
          managed: true,
        },
        {
          id: "env-archived",
          projectId: "proj-1",
          descriptor: {
            type: "path",
            path: archivedWorkspacePath,
          },
          managed: true,
        },
      ],
      environmentAttachments: [
        {
          threadId: liveThread.id,
          environmentId: "env-live",
        },
        {
          threadId: archivedThread.id,
          environmentId: "env-archived",
        },
      ],
      projects: [project],
      runtimeEnv: process.env,
      now: Date.now(),
      archivedLogRetentionMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(result.removedWorkspaceDirectories).toBe(3);
    expect(existsSync(liveWorkspacePath)).toBe(true);
    expect(existsSync(archivedWorkspacePath)).toBe(false);
    expect(existsSync(join(worktreeRoot, "orphan-thread"))).toBe(false);
    expect(existsSync(resolve(bbRoot, "worktrees", "orphan-project"))).toBe(false);
  });
});

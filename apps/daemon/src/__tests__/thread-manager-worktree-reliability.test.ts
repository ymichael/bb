import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@beanbag/agent-core";
import type {
  EventRepository,
  ProjectRepository,
  ThreadRepository,
} from "@beanbag/db";
import {
  createWorktreeEnvironmentAdapter,
  type LlmCompletionService,
} from "@beanbag/agent-server";
import { ThreadManager } from "../thread-manager.js";
import { WSManager } from "../ws.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGitRepo(repoRoot: string): void {
  git(repoRoot, "init");
  git(repoRoot, "config", "user.name", "Beanbag Test");
  git(repoRoot, "config", "user.email", "beanbag-test@example.com");
  git(repoRoot, "checkout", "-b", "main");
  writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf-8");
  git(repoRoot, "add", "README.md");
  git(repoRoot, "commit", "-m", "initial");
}

function makeThread(args: {
  id: string;
  projectId: string;
  status: Thread["status"];
}): Thread {
  return {
    id: args.id,
    projectId: args.projectId,
    status: args.status,
    createdAt: 1,
    updatedAt: 1,
    environmentId: "worktree",
  };
}

function createManager(args: {
  thread: Thread;
  projectRoot: string;
}): ThreadManager {
  const llmCompletionService: LlmCompletionService = {
    displayName: "Mock LLM",
    generateThreadTitle: vi.fn().mockResolvedValue(undefined),
    generateCommitMessage: vi.fn().mockResolvedValue(undefined),
  };
  const threadRepo = {
    create: vi.fn(),
    getById: vi.fn((threadId: string) => (threadId === args.thread.id ? args.thread : undefined)),
    list: vi.fn(() => []),
    update: vi.fn(),
    markRead: vi.fn(),
    delete: vi.fn(),
  } as unknown as ThreadRepository;

  const eventRepo = {
    create: vi.fn(),
    listByThread: vi.fn(() => []),
    getLatestSeq: vi.fn(() => 0),
    getLatestByType: vi.fn(() => undefined),
  } as unknown as EventRepository;

  const projectRepo = {
    create: vi.fn(),
    getById: vi.fn((projectId: string) => {
      if (projectId !== args.thread.projectId) return undefined;
      return {
        id: args.thread.projectId,
        name: "Repo",
        rootPath: args.projectRoot,
        createdAt: 1,
        updatedAt: 1,
      };
    }),
    list: vi.fn(() => []),
    delete: vi.fn(),
  } as unknown as ProjectRepository;

  const ws = {
    broadcast: vi.fn(),
    handleConnection: vi.fn(),
    close: vi.fn(),
  } as unknown as WSManager;

  return new ThreadManager(
    threadRepo,
    eventRepo,
    projectRepo,
    ws,
    llmCompletionService,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ThreadManager worktree reliability", () => {
  it("keeps worktree files intact when stopping a worktree thread", () => {
    const repoRoot = makeTempDir("bb-thread-manager-stop-worktree-");
    initGitRepo(repoRoot);

    const thread = makeThread({
      id: "thread-stop",
      projectId: "proj-1",
      status: "active",
    });
    const manager = createManager({
      thread,
      projectRoot: repoRoot,
    });
    const adapter = createWorktreeEnvironmentAdapter({
      worktreeRootName: ".beanbag-test-worktrees",
    });
    const session = adapter.prepare({
      projectId: thread.projectId,
      threadId: thread.id,
      projectRootPath: repoRoot,
      runtimeEnv: process.env,
    });

    expect(session.metadata?.mode).toBe("worktree");
    const scratchPath = join(session.cwd, "WORKTREE_NOTE.md");
    writeFileSync(scratchPath, "do not lose\n", "utf-8");
    expect(existsSync(scratchPath)).toBe(true);

    (manager as unknown as {
      environmentRuntimes: Map<string, { adapter: typeof adapter; session: typeof session }>;
    }).environmentRuntimes.set(thread.id, {
      adapter,
      session,
    });

    manager.stop(thread.id);

    expect(existsSync(session.cwd)).toBe(true);
    expect(existsSync(scratchPath)).toBe(true);
  });

  it("removes worktree checkout on archive while preserving committed branch work", () => {
    const repoRoot = makeTempDir("bb-thread-manager-archive-worktree-");
    initGitRepo(repoRoot);
    const mainHeadBefore = git(repoRoot, "rev-parse", "HEAD");

    const thread = makeThread({
      id: "thread-archive",
      projectId: "proj-1",
      status: "idle",
    });
    const manager = createManager({
      thread,
      projectRoot: repoRoot,
    });
    const adapter = createWorktreeEnvironmentAdapter({
      worktreeRootName: ".beanbag-test-worktrees",
    });
    const session = adapter.prepare({
      projectId: thread.projectId,
      threadId: thread.id,
      projectRootPath: repoRoot,
      runtimeEnv: process.env,
    });

    expect(session.metadata?.mode).toBe("worktree");
    writeFileSync(join(session.cwd, "FEATURE.md"), "feature work\n", "utf-8");
    git(session.cwd, "add", "FEATURE.md");
    git(session.cwd, "commit", "-m", "feature commit");
    const worktreeHead = git(session.cwd, "rev-parse", "HEAD");

    (manager as unknown as {
      environmentRuntimes: Map<string, { adapter: typeof adapter; session: typeof session }>;
    }).environmentRuntimes.set(thread.id, {
      adapter,
      session,
    });

    manager.archive(thread.id);

    expect(existsSync(session.cwd)).toBe(false);
    expect(git(repoRoot, "rev-parse", "HEAD")).toBe(mainHeadBefore);
    expect(git(repoRoot, "rev-parse", "bb/thread-thread-archive")).toBe(worktreeHead);
  });
});

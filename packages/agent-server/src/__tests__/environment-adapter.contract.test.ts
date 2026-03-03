import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  EnvironmentPrepareContext,
  EnvironmentProvisioningEvent,
  EnvironmentSession,
} from "@beanbag/agent-core";
import {
  createLocalEnvironmentAdapter,
  createWorktreeEnvironmentAdapter,
} from "../environment-adapter.js";

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
  }).trim();
}

function createPrepareContext(args: {
  projectId: string;
  threadId: string;
  projectRootPath: string;
  onProvisioningEvent?: (event: EnvironmentProvisioningEvent) => void;
}): EnvironmentPrepareContext {
  return {
    projectId: args.projectId,
    threadId: args.threadId,
    projectRootPath: args.projectRootPath,
    runtimeEnv: process.env,
    ...(args.onProvisioningEvent
      ? { onProvisioningEvent: args.onProvisioningEvent }
      : {}),
  };
}

function assertSessionBaseContract(args: {
  session: EnvironmentSession;
  expectedWorkspaceRoot: string;
  expectedMode: string;
}): void {
  expect(args.session.cwd).toBe(args.expectedWorkspaceRoot);
  expect(args.session.env?.BB_WORKSPACE_ROOT).toBe(args.expectedWorkspaceRoot);
  expect(args.session.metadata?.workspaceRoot).toBe(args.expectedWorkspaceRoot);
  expect(args.session.metadata?.mode).toBe(args.expectedMode);
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("environment adapter contract", () => {
  it("local adapter satisfies prepare contract", () => {
    const projectRoot = makeTempDir("bb-env-contract-local-");
    const context = createPrepareContext({
      projectId: "proj-local",
      threadId: "thread-local",
      projectRootPath: projectRoot,
    });

    const adapter = createLocalEnvironmentAdapter();
    const session = adapter.prepare(context);

    assertSessionBaseContract({
      session,
      expectedWorkspaceRoot: projectRoot,
      expectedMode: "local",
    });
    expect(session.env?.BB_WORKSPACE_MODE).toBe("local");
    expect(session.cleanup).toBeUndefined();
  });

  it("worktree adapter satisfies prepare contract in git repos", () => {
    const projectRoot = makeTempDir("bb-env-contract-worktree-");
    initGitRepo(projectRoot);

    const adapter = createWorktreeEnvironmentAdapter({
      worktreeRootName: ".beanbag-test-worktrees",
    });
    const session = adapter.prepare(
      createPrepareContext({
        projectId: "proj-worktree",
        threadId: "thread-worktree",
        projectRootPath: projectRoot,
      }),
    );

    assertSessionBaseContract({
      session,
      expectedWorkspaceRoot: join(
        projectRoot,
        ".beanbag-test-worktrees",
        "thread-worktree",
      ),
      expectedMode: "worktree",
    });
    expect(session.env?.BB_WORKSPACE_MODE).toBe("worktree");
    expect(typeof session.cleanup).toBe("function");
    expect(existsSync(session.cwd)).toBe(true);
    expect(readFileSync(join(projectRoot, "README.md"), "utf-8")).toBe("initial\n");
  });

  it("worktree adapter cleans up only the isolated workspace", () => {
    const projectRoot = makeTempDir("bb-env-contract-cleanup-");
    initGitRepo(projectRoot);

    const adapter = createWorktreeEnvironmentAdapter({
      worktreeRootName: ".beanbag-test-worktrees",
    });
    const session = adapter.prepare(
      createPrepareContext({
        projectId: "proj-cleanup",
        threadId: "thread-cleanup",
        projectRootPath: projectRoot,
      }),
    );

    writeFileSync(join(session.cwd, "THREAD_NOTES.md"), "isolated note\n", "utf-8");
    expect(existsSync(join(session.cwd, "THREAD_NOTES.md"))).toBe(true);
    expect(existsSync(join(projectRoot, "README.md"))).toBe(true);

    session.cleanup?.();
    session.cleanup?.();

    expect(existsSync(session.cwd)).toBe(false);
    expect(existsSync(join(projectRoot, "README.md"))).toBe(true);
    expect(readFileSync(join(projectRoot, "README.md"), "utf-8")).toBe("initial\n");
  });

  it("worktree adapter falls back to local mode outside git repos", () => {
    const projectRoot = makeTempDir("bb-env-contract-fallback-non-git-");

    const adapter = createWorktreeEnvironmentAdapter({
      worktreeRootName: ".beanbag-test-worktrees",
    });
    const session = adapter.prepare(
      createPrepareContext({
        projectId: "proj-fallback",
        threadId: "thread-fallback",
        projectRootPath: projectRoot,
      }),
    );

    assertSessionBaseContract({
      session,
      expectedWorkspaceRoot: projectRoot,
      expectedMode: "local",
    });
    expect(session.env?.BB_WORKSPACE_MODE).toBe("local-fallback");
    expect(session.metadata?.fallbackReason).toBe("missing-git-root");
  });

  it("worktree adapter falls back to local mode when git worktree add fails", () => {
    const projectRoot = makeTempDir("bb-env-contract-fallback-failed-add-");
    initGitRepo(projectRoot);

    const adapter = createWorktreeEnvironmentAdapter({
      gitCommand: join(projectRoot, "missing-git"),
      worktreeRootName: ".beanbag-test-worktrees",
    });
    const session = adapter.prepare(
      createPrepareContext({
        projectId: "proj-fallback-failed-add",
        threadId: "thread-fallback-failed-add",
        projectRootPath: projectRoot,
      }),
    );

    assertSessionBaseContract({
      session,
      expectedWorkspaceRoot: projectRoot,
      expectedMode: "local",
    });
    expect(session.env?.BB_WORKSPACE_MODE).toBe("local-fallback");
    expect(session.metadata?.fallbackReason).toBe("worktree-add-failed");
  });

  it("runs optional .bb-env-setup.sh and emits provisioning events", () => {
    const projectRoot = makeTempDir("bb-env-contract-env-setup-");
    initGitRepo(projectRoot);

    writeFileSync(
      join(projectRoot, ".bb-env-setup.sh"),
      [
        '#!/usr/bin/env sh',
        'printf "%s|%s\\n" "$BB_THREAD_ID" "$BB_WORKSPACE_MODE" >> env-setup.log',
      ].join("\n"),
      "utf-8",
    );
    git(projectRoot, "add", ".bb-env-setup.sh");
    git(projectRoot, "commit", "-m", "add env setup hook");

    const events: EnvironmentProvisioningEvent[] = [];
    const adapter = createWorktreeEnvironmentAdapter({
      worktreeRootName: ".beanbag-test-worktrees",
    });
    const session = adapter.prepare(
      createPrepareContext({
        projectId: "proj-env-setup",
        threadId: "thread-env-setup",
        projectRootPath: projectRoot,
        onProvisioningEvent: (event) => {
          events.push(event);
        },
      }),
    );

    expect(readFileSync(join(session.cwd, "env-setup.log"), "utf-8")).toContain(
      "thread-env-setup|worktree",
    );
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: "env-setup",
        status: "started",
        scriptPath: ".bb-env-setup.sh",
      }),
    );
    expect(events[1]).toEqual(
      expect.objectContaining({
        type: "env-setup",
        status: "completed",
        scriptPath: ".bb-env-setup.sh",
      }),
    );
    session.cleanup?.();
  });

  it("surfaces .bb-env-setup.sh failures and emits a failed event", () => {
    const projectRoot = makeTempDir("bb-env-contract-env-setup-failed-");
    initGitRepo(projectRoot);

    writeFileSync(
      join(projectRoot, ".bb-env-setup.sh"),
      '#!/usr/bin/env sh\necho "setup failed for test" >&2\nexit 1\n',
      "utf-8",
    );
    git(projectRoot, "add", ".bb-env-setup.sh");
    git(projectRoot, "commit", "-m", "add failing env setup hook");

    const events: EnvironmentProvisioningEvent[] = [];
    const adapter = createWorktreeEnvironmentAdapter({
      worktreeRootName: ".beanbag-test-worktrees",
    });
    expect(() =>
      adapter.prepare(
        createPrepareContext({
          projectId: "proj-env-setup-failed",
          threadId: "thread-env-setup-failed",
          projectRootPath: projectRoot,
          onProvisioningEvent: (event) => {
            events.push(event);
          },
        }),
      )).toThrow(".bb-env-setup.sh failed");
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: "env-setup",
        status: "started",
        scriptPath: ".bb-env-setup.sh",
      }),
    );
    expect(events[1]).toEqual(
      expect.objectContaining({
        type: "env-setup",
        status: "failed",
        scriptPath: ".bb-env-setup.sh",
      }),
    );
  });

  it("keeps full .bb-env-setup.sh failure detail for UI scrolling", () => {
    const projectRoot = makeTempDir("bb-env-contract-env-setup-full-detail-");
    initGitRepo(projectRoot);

    const longDetail = `setup-${"x".repeat(1200)}-detail`;
    writeFileSync(
      join(projectRoot, ".bb-env-setup.sh"),
      [
        "#!/usr/bin/env sh",
        `printf "%s\\n" "${longDetail}" >&2`,
        "exit 1",
      ].join("\n"),
      "utf-8",
    );
    git(projectRoot, "add", ".bb-env-setup.sh");
    git(projectRoot, "commit", "-m", "add long failing env setup hook");

    const events: EnvironmentProvisioningEvent[] = [];
    const adapter = createWorktreeEnvironmentAdapter({
      worktreeRootName: ".beanbag-test-worktrees",
    });
    expect(() =>
      adapter.prepare(
        createPrepareContext({
          projectId: "proj-env-setup-full-detail",
          threadId: "thread-env-setup-full-detail",
          projectRootPath: projectRoot,
          onProvisioningEvent: (event) => {
            events.push(event);
          },
        }),
      )).toThrow(`.bb-env-setup.sh failed: ${longDetail}`);

    const failedEvent = events[1];
    expect(failedEvent).toEqual(
      expect.objectContaining({
        type: "env-setup",
        status: "failed",
        scriptPath: ".bb-env-setup.sh",
      }),
    );
    expect(failedEvent?.detail).toBe(longDetail);
    expect(failedEvent?.detail?.length ?? 0).toBeGreaterThan(400);
    expect(failedEvent?.detail?.endsWith("…")).toBe(false);
  });
});

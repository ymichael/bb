import { lstatSync, readdirSync, type Dirent } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IEnvironment, EnvironmentCommandResult } from "../contracts.js";
import {
  getGitWorkspaceDiffAsync,
  getGitWorkspaceStatusAsync,
  watchGitWorkspaceStatus,
} from "../git-workspace.js";

const watchListeners: Array<() => void> = [];
const mockedLstatSync = vi.mocked(lstatSync);
const mockedReaddirSync = vi.mocked(readdirSync);

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    lstatSync: vi.fn(() => ({
      isDirectory: () => true,
      isFile: () => false,
    })),
    readdirSync: vi.fn(() => []),
    watch: vi.fn((_target: string, _options: unknown, listener: () => void) => {
      watchListeners.push(listener);
      return {
        close: vi.fn(),
        on: vi.fn(),
      };
    }),
  };
});

function ok(stdout = ""): EnvironmentCommandResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
  };
}

function mockDirEntry(name: string, isDirectory: boolean): Dirent {
  return {
    name,
    parentPath: "",
    path: "",
    isDirectory: () => isDirectory,
    isFile: () => !isDirectory,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as unknown as Dirent;
}

function createEnvironment(getStatusOutput: () => string): IEnvironment {
  return {
    kind: "test",
    info: {
      id: "test",
      displayName: "Test",
      capabilities: {
        host_filesystem: true,
        isolated_workspace: true,
        promote_primary_checkout: false,
        demote_primary_checkout: false,
        squash_merge: false,
      },
    },
    serialize: () => ({}),
    suspend: () => {},
    destroy: () => {},
    exists: () => true,
    supportsHostFilesystemAccess: () => true,
    isIsolatedWorkspace: () => true,
    getAgentConnectionTarget: () => ({
      transport: "http",
      baseUrl: "http://127.0.0.1:4312",
    }),
    getCheckoutSnapshot: () => ({
      head: "head",
      detached: false,
    }),
    getWorkspaceRootUnsafe: () => "/repo",
    getWorkspaceStatus: () => {
      throw new Error("not used in this test");
    },
    watchWorkspaceStatus: () => () => {},
    commitWorkspace: async () => {
      throw new Error("not implemented");
    },
    listWorkspaceCommitsSinceRef: () => [],
    getWorkspaceDiff: () => ({ diff: "", truncated: false }),
    spawn: () => {
      throw new Error("not implemented");
    },
    shouldRunSetupScript: () => false,
    supportsPromoteToActiveWorkspace: () => false,
    supportsDemoteFromActiveWorkspace: () => false,
    supportsSquashMergeIntoDefaultBranch: () => false,
    promoteToActiveWorkspace: () => {
      throw new Error("not implemented");
    },
    demoteFromActiveWorkspace: () => {
      throw new Error("not implemented");
    },
    squashMergeIntoDefaultBranch: async () => {
      throw new Error("not implemented");
    },
    run: () => {
      throw new Error("not used in this test");
    },
    runAsync: async (_command, args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return ok("true");
      }
      if (args[0] === "symbolic-ref" && args[1] === "--quiet") {
        return ok("refs/remotes/origin/main");
      }
      if (args[0] === "status") {
        return ok(getStatusOutput());
      }
      if (args[0] === "diff" && args[1] === "--shortstat") {
        return ok("");
      }
      if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--shortstat") {
        return ok("");
      }
      if (args[0] === "symbolic-ref" && args[1] === "--short") {
        return ok("feature");
      }
      if (args[0] === "for-each-ref") {
        return ok("feature\nmain");
      }
      if (args[0] === "show-ref") {
        return ok("");
      }
      if (args[0] === "merge-base") {
        return ok("abc123");
      }
      if (args[0] === "rev-list") {
        return ok("0\t0");
      }
      if (args[0] === "cherry") {
        return ok("");
      }
      if (args[0] === "diff" && args[1] === "--name-only") {
        return ok("");
      }
      if (args[0] === "diff" && args[1] === "--name-status") {
        return ok("");
      }
      return ok("");
    },
  };
}

afterEach(() => {
  watchListeners.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("watchGitWorkspaceStatus", () => {
  it("ignores metadata churn when the computed work status is unchanged", async () => {
    vi.useFakeTimers();
    let statusOutput = "";
    const environment = createEnvironment(() => statusOutput);
    const onChange = vi.fn();

    const stopWatching = watchGitWorkspaceStatus(environment, onChange);
    expect(watchListeners.length).toBeGreaterThan(0);

    for (const listener of watchListeners) {
      listener();
    }
    await vi.advanceTimersByTimeAsync(100);

    expect(onChange).not.toHaveBeenCalled();

    statusOutput = " M README.md";
    for (const listener of watchListeners) {
      listener();
    }
    await vi.advanceTimersByTimeAsync(100);

    expect(onChange).toHaveBeenCalledTimes(1);

    stopWatching();
  });
});

describe("getGitWorkspaceStatusAsync", () => {
  it("falls back to collapsed untracked status output when exhaustive porcelain overflows", async () => {
    const environment = createEnvironment(() => "");
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return ok("true");
      }
      if (args[0] === "symbolic-ref" && args[1] === "--quiet") {
        return ok("refs/remotes/origin/main");
      }
      if (args[0] === "status" && args.includes("--untracked-files=all")) {
        return {
          exitCode: null,
          stdout: "",
          stderr: "spawnSync git ENOBUFS",
        };
      }
      if (args[0] === "status" && args.includes("--untracked-files=normal")) {
        return ok(" M README.md\n?? .pnpm-store/");
      }
      if (args[0] === "diff" && args[1] === "--shortstat") {
        return ok(" 1 file changed, 1 insertion(+), 5 deletions(-)");
      }
      if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--shortstat") {
        return ok("");
      }
      if (args[0] === "symbolic-ref" && args[1] === "--short") {
        return ok("feature");
      }
      if (args[0] === "for-each-ref") {
        return ok("feature\nmain");
      }
      if (args[0] === "show-ref") {
        return ok("");
      }
      if (args[0] === "merge-base") {
        return ok("abc123");
      }
      if (args[0] === "rev-list") {
        return ok("0\t0");
      }
      if (args[0] === "diff" && args[1] === "--name-status") {
        return ok("");
      }
      if (args[0] === "cherry") {
        return ok("");
      }
      return ok("");
    });

    const overflowEnvironment: IEnvironment = {
      ...environment,
      runAsync: run,
    };

    const status = await getGitWorkspaceStatusAsync(overflowEnvironment, {
      defaultBranch: "main",
    });

    expect(status.state).toBe("dirty_uncommitted");
    expect(status.hasUncommittedChanges).toBe(true);
    expect(status.workspaceChangedFiles).toBe(2);
    expect(status.workspaceInsertions).toBe(1);
    expect(status.workspaceDeletions).toBe(5);
    expect(status.files).toEqual([
      { status: "M?", path: "README.md" },
      { status: "A?", path: ".pnpm-store/" },
    ]);
  });
});

describe("getGitWorkspaceDiffAsync", () => {
  it("appends untracked files to working tree diffs", async () => {
    const trackedDiff = [
      "diff --git a/src/existing.ts b/src/existing.ts",
      "index 1111111..2222222 100644",
      "--- a/src/existing.ts",
      "+++ b/src/existing.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const untrackedDiff = [
      "diff --git a/notes.txt b/notes.txt",
      "new file mode 100644",
      "index 0000000..ce01362",
      "--- /dev/null",
      "+++ b/notes.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");
    const run = vi.fn(async (_command: string, args: string[], options?: { rawOutput?: boolean }) => {
      if (args[0] === "status") {
        return ok("?? notes.txt");
      }
      if (args[0] === "diff" && args[1] === "--binary" && args[2] === "HEAD") {
        return ok(trackedDiff);
      }
      if (args[0] === "diff" && args[1] === "--binary" && args[2] === "--no-index") {
        expect(options).toEqual({ rawOutput: true });
        expect(args.slice(-2)).toEqual(["/dev/null", "notes.txt"]);
        return {
          exitCode: 1,
          stdout: untrackedDiff,
          stderr: "",
        };
      }
      return ok("");
    });
    const environment: IEnvironment = {
      ...createEnvironment(() => "?? notes.txt"),
      runAsync: run,
    };
    mockedLstatSync.mockImplementation(() => ({
      isDirectory: () => false,
      isFile: () => true,
    }) as ReturnType<typeof lstatSync>);
    mockedReaddirSync.mockImplementation(() => []);

    await expect(getGitWorkspaceDiffAsync(environment, { type: "working_tree" })).resolves.toEqual({
      diff: `${trackedDiff}${untrackedDiff}`,
      truncated: false,
    });
  });

  it("includes untracked files in combined diffs", async () => {
    const trackedDiff = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "index 1111111..2222222 100644",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const untrackedDiff = [
      "diff --git a/scratch.txt b/scratch.txt",
      "new file mode 100644",
      "index 0000000..ce01362",
      "--- /dev/null",
      "+++ b/scratch.txt",
      "@@ -0,0 +1 @@",
      "+draft",
      "",
    ].join("\n");
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "merge-base") {
        return ok("abc123");
      }
      if (args[0] === "status") {
        return ok("?? scratch.txt");
      }
      if (args[0] === "diff" && args[1] === "--binary" && args[2] === "abc123") {
        return ok(trackedDiff);
      }
      if (args[0] === "diff" && args[1] === "--binary" && args[2] === "--no-index") {
        return {
          exitCode: 1,
          stdout: untrackedDiff,
          stderr: "",
        };
      }
      return ok("");
    });
    const environment: IEnvironment = {
      ...createEnvironment(() => "?? scratch.txt"),
      runAsync: run,
    };
    mockedLstatSync.mockImplementation(() => ({
      isDirectory: () => false,
      isFile: () => true,
    }) as ReturnType<typeof lstatSync>);
    mockedReaddirSync.mockImplementation(() => []);

    await expect(getGitWorkspaceDiffAsync(environment, {
      type: "combined",
      baseRef: "origin/main",
    })).resolves.toEqual({
      diff: `${trackedDiff}${untrackedDiff}`,
      truncated: false,
    });
  });

  it("expands small untracked directories into file diffs", async () => {
    const trackedDiff = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "index 1111111..2222222 100644",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const directoryFileDiff = [
      "diff --git a/plans/XYZ.md b/plans/XYZ.md",
      "new file mode 100644",
      "index 0000000..ce01362",
      "--- /dev/null",
      "+++ b/plans/XYZ.md",
      "@@ -0,0 +1 @@",
      "+draft plan",
      "",
    ].join("\n");
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "status") {
        return ok("?? plans/");
      }
      if (args[0] === "diff" && args[1] === "--binary" && args[2] === "HEAD") {
        return ok(trackedDiff);
      }
      if (args[0] === "ls-files") {
        return ok("plans/XYZ.md");
      }
      if (args[0] === "diff" && args[1] === "--binary" && args[2] === "--no-index") {
        expect(args.slice(-2)).toEqual(["/dev/null", "plans/XYZ.md"]);
        return {
          exitCode: 1,
          stdout: directoryFileDiff,
          stderr: "",
        };
      }
      return ok("");
    });
    const environment: IEnvironment = {
      ...createEnvironment(() => "?? plans/"),
      runAsync: run,
    };

    mockedLstatSync.mockImplementation((path) => {
      if (String(path).endsWith("plans")) {
        return {
          isDirectory: () => true,
          isFile: () => false,
        } as ReturnType<typeof lstatSync>;
      }
      return {
        isDirectory: () => false,
        isFile: () => true,
      } as ReturnType<typeof lstatSync>;
    });
    mockedReaddirSync.mockImplementation(() => ([
      mockDirEntry("XYZ.md", false),
    ] as unknown as ReturnType<typeof readdirSync>));

    await expect(getGitWorkspaceDiffAsync(environment, { type: "working_tree" })).resolves.toEqual({
      diff: `${trackedDiff}${directoryFileDiff}`,
      truncated: false,
    });
    expect(run).toHaveBeenCalledWith(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", "plans/"],
      expect.anything(),
    );
  });

  it("skips large untracked directories", async () => {
    const trackedDiff = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "index 1111111..2222222 100644",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "status") {
        return ok("?? node_modules/");
      }
      if (args[0] === "diff" && args[1] === "--binary" && args[2] === "HEAD") {
        return ok(trackedDiff);
      }
      return ok("");
    });
    const environment: IEnvironment = {
      ...createEnvironment(() => "?? node_modules/"),
      runAsync: run,
    };

    mockedLstatSync.mockImplementation((path) => {
      if (String(path).endsWith("node_modules")) {
        return {
          isDirectory: () => true,
          isFile: () => false,
        } as ReturnType<typeof lstatSync>;
      }
      return {
        isDirectory: () => false,
        isFile: () => true,
      } as ReturnType<typeof lstatSync>;
    });
    mockedReaddirSync.mockImplementation(() => (Array.from(
      { length: 25 },
      (_, index) => mockDirEntry(`file-${index}.txt`, false),
    ) as unknown as ReturnType<typeof readdirSync>));

    await expect(getGitWorkspaceDiffAsync(environment, { type: "working_tree" })).resolves.toEqual({
      diff: trackedDiff,
      truncated: false,
    });
    expect(run).not.toHaveBeenCalledWith(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", "node_modules/"],
      expect.anything(),
    );
  });

  it("caps how many untracked files are expanded into the diff payload", async () => {
    const fileCount = 30;
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "status") {
        return ok(Array.from({ length: fileCount }, (_, index) => `?? file-${index}.txt`).join("\n"));
      }
      if (args[0] === "diff" && args[1] === "--binary" && args[2] === "HEAD") {
        return ok("");
      }
      if (args[0] === "diff" && args[1] === "--binary" && args[2] === "--no-index") {
        const path = args[args.length - 1];
        return {
          exitCode: 1,
          stdout: [
            `diff --git a/${path} b/${path}`,
            "new file mode 100644",
            "index 0000000..ce01362",
            "--- /dev/null",
            `+++ b/${path}`,
            "@@ -0,0 +1 @@",
            `+${path}`,
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      return ok("");
    });
    const environment: IEnvironment = {
      ...createEnvironment(() => ""),
      runAsync: run,
    };

    mockedLstatSync.mockImplementation(() => ({
      isDirectory: () => false,
      isFile: () => true,
    }) as ReturnType<typeof lstatSync>);
    mockedReaddirSync.mockImplementation(() => []);

    const result = await getGitWorkspaceDiffAsync(environment, { type: "working_tree" });
    expect(result.truncated).toBe(false);
    expect(result.diff).toContain("file-0.txt");
    expect(result.diff).toContain("file-23.txt");
    expect(result.diff).not.toContain("file-24.txt");
  });
});

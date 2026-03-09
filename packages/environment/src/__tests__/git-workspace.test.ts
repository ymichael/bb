import { afterEach, describe, expect, it, vi } from "vitest";
import type { IEnvironment, EnvironmentCommandResult } from "../contracts.js";
import { watchGitWorkspaceStatus } from "../git-workspace.js";

const watchListeners: Array<() => void> = [];

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    lstatSync: vi.fn(() => ({
      isDirectory: () => true,
      isFile: () => false,
    })),
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
    dispose: () => {},
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
    run: (_command, args) => {
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
  it("ignores metadata churn when the computed work status is unchanged", () => {
    vi.useFakeTimers();
    let statusOutput = "";
    const environment = createEnvironment(() => statusOutput);
    const onChange = vi.fn();

    const stopWatching = watchGitWorkspaceStatus(environment, onChange);
    expect(watchListeners.length).toBeGreaterThan(0);

    for (const listener of watchListeners) {
      listener();
    }
    vi.advanceTimersByTime(100);

    expect(onChange).not.toHaveBeenCalled();

    statusOutput = " M README.md";
    for (const listener of watchListeners) {
      listener();
    }
    vi.advanceTimersByTime(100);

    expect(onChange).toHaveBeenCalledTimes(1);

    stopWatching();
  });
});

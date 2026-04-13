import { describe, expect, it } from "vitest";
import type { Environment } from "@bb/domain";
import { formatEnvironmentDisplay } from "../src/environment-display.js";

function makeEnvironment(overrides?: Partial<Environment>): Environment {
  return {
    id: "env_test",
    projectId: "proj_test",
    hostId: "host_test",
    path: "/workspace",
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    workspaceProvisionType: "unmanaged",
    branchName: null,
    defaultBranch: null,
    mergeBaseBranch: null,
    cleanupRequestedAt: null,
    cleanupMode: null,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("formatEnvironmentDisplay", () => {
  describe("local host", () => {
    it("returns 'Direct' for unmanaged workspace", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment(),
        isLocalHost: true,
      });
      expect(result).toEqual({
        modeLabel: "Direct",
        hostLabel: null,
        id: "env_test",
        location: "local",
        mode: "direct",
        workspaceDisplayKind: "primary-checkout",
      });
    });

    it("returns 'Worktree' for worktree workspace", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment({ isWorktree: true, workspaceProvisionType: "managed-worktree" }),
        isLocalHost: true,
      });
      expect(result).toEqual({
        modeLabel: "Worktree",
        hostLabel: null,
        id: "env_test",
        location: "local",
        mode: "worktree",
        workspaceDisplayKind: "git-worktree",
      });
    });

    it("passes through host name when provided", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment(),
        isLocalHost: true,
        hostName: "My Machine",
      });
      expect(result.modeLabel).toBe("Direct");
      expect(result.hostLabel).toBe("My Machine");
    });
  });

  describe("remote host", () => {
    it("includes host name when provided", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment(),
        isLocalHost: false,
        hostName: "Remote Server",
      });
      expect(result).toEqual({
        modeLabel: "Direct",
        hostLabel: "Remote Server",
        id: "env_test",
        location: "remote",
        mode: "direct",
        workspaceDisplayKind: "primary-checkout",
      });
    });

    it("includes host name with worktree mode", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment({ isWorktree: true }),
        isLocalHost: false,
        hostName: "Remote Server",
      });
      expect(result).toEqual({
        modeLabel: "Worktree",
        hostLabel: "Remote Server",
        id: "env_test",
        location: "remote",
        mode: "worktree",
        workspaceDisplayKind: "git-worktree",
      });
    });

    it("returns null hostLabel when host name is missing", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment(),
        isLocalHost: false,
      });
      expect(result.modeLabel).toBe("Direct");
      expect(result.hostLabel).toBeNull();
      expect(result.location).toBe("remote");
    });
  });

  describe("ephemeral (sandbox) host", () => {
    it("uses sandbox provider name as modeLabel", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment(),
        isLocalHost: false,
        hostType: "ephemeral",
        hostProvider: "e2b",
      });
      expect(result).toEqual({
        modeLabel: "E2B Sandbox",
        hostLabel: null,
        id: "env_test",
        location: "cloud",
        mode: "direct",
        workspaceDisplayKind: "sandbox",
      });
    });

    it("falls back to 'Sandbox' when provider name is missing", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment(),
        isLocalHost: false,
        hostType: "ephemeral",
      });
      expect(result.modeLabel).toBe("Sandbox");
      expect(result.location).toBe("cloud");
    });

    it("reports worktree mode for sandbox worktrees", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment({ isWorktree: true }),
        isLocalHost: false,
        hostType: "ephemeral",
        hostProvider: "e2b",
      });
      expect(result.mode).toBe("worktree");
      expect(result.modeLabel).toBe("E2B Sandbox");
      expect(result.workspaceDisplayKind).toBe("sandbox");
    });
  });
});

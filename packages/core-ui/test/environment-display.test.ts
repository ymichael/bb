import { describe, expect, it } from "vitest";
import type { Environment } from "@bb/domain";
import { makeEnvironment as makeEnvironmentFixture } from "@bb/test-helpers/domain-fixtures";
import {
  formatEnvironmentDisplay,
  type EnvironmentDisplayHostContext,
} from "../src/environment-display.js";

const localHostContext: EnvironmentDisplayHostContext = {
  locality: "local",
  identity: null,
};

const remoteHostContext: EnvironmentDisplayHostContext = {
  locality: "remote",
  identity: null,
};

function makeDisplayEnvironment(overrides?: Partial<Environment>): Environment {
  return makeEnvironmentFixture({
    managed: false,
    isWorktree: false,
    workspaceProvisionType: "unmanaged",
    baseBranch: null,
    branchName: null,
    defaultBranch: null,
    ...overrides,
  });
}

describe("formatEnvironmentDisplay", () => {
  describe("display labels", () => {
    it("returns 'Working locally' for unmanaged workspace", () => {
      const result = formatEnvironmentDisplay({
        environment: makeDisplayEnvironment(),
        host: localHostContext,
      });
      expect(result).toEqual({
        modeLabel: "Working locally",
        compactModeLabel: "Local",
        lifecycle: null,
        id: "env_test",
        mode: "direct",
        workspaceDisplayKind: "other",
      });
    });

    it("returns a remote label for remote unmanaged workspace", () => {
      const result = formatEnvironmentDisplay({
        environment: makeDisplayEnvironment(),
        host: remoteHostContext,
      });
      expect(result).toEqual({
        modeLabel: "Working remotely",
        compactModeLabel: "Remote",
        lifecycle: null,
        id: "env_test",
        mode: "direct",
        workspaceDisplayKind: "other",
      });
    });

    it("returns 'Worktree' for worktree workspace", () => {
      const result = formatEnvironmentDisplay({
        environment: makeDisplayEnvironment({
          isWorktree: true,
          workspaceProvisionType: "managed-worktree",
        }),
        host: remoteHostContext,
      });
      expect(result).toEqual({
        modeLabel: "Worktree",
        compactModeLabel: "Worktree",
        lifecycle: null,
        id: "env_test",
        mode: "worktree",
        workspaceDisplayKind: "managed-worktree",
      });
    });

    it("uses a custom environment name when one is present", () => {
      const result = formatEnvironmentDisplay({
        environment: makeDisplayEnvironment({
          isWorktree: true,
          name: "Review workspace",
          workspaceProvisionType: "managed-worktree",
        }),
        host: remoteHostContext,
      });

      expect(result.modeLabel).toBe("Review workspace");
      expect(result.compactModeLabel).toBe("Review workspace");
    });

    it("does not compact custom names that resemble generated labels", () => {
      const result = formatEnvironmentDisplay({
        environment: makeDisplayEnvironment({
          name: "Working locally copy",
        }),
        host: remoteHostContext,
      });

      expect(result.modeLabel).toBe("Working locally copy");
      expect(result.compactModeLabel).toBe("Working locally copy");
    });

    it("uses local direct-workspace display for personal environments", () => {
      const result = formatEnvironmentDisplay({
        environment: makeDisplayEnvironment({
          isGitRepo: false,
          workspaceProvisionType: "personal",
        }),
        host: localHostContext,
      });
      expect(result).toMatchObject({
        modeLabel: "Working locally",
        compactModeLabel: "Local",
        mode: "direct",
        workspaceDisplayKind: "other",
      });
    });
  });

  describe("provisioning", () => {
    it("reports 'Provisioning' for a worktree env before discovery populates isWorktree", () => {
      const result = formatEnvironmentDisplay({
        environment: makeDisplayEnvironment({
          status: "provisioning",
          workspaceProvisionType: "managed-worktree",
          isWorktree: false,
        }),
        host: remoteHostContext,
      });
      expect(result.modeLabel).toBe("Provisioning");
      expect(result.compactModeLabel).toBe("Provisioning");
      expect(result.mode).toBe("direct");
    });

    it("reports 'Destroying'/'Destroyed' for a gone managed worktree instead of 'Provisioning' (#1789)", () => {
      for (const [status, label] of [
        ["destroying", "Destroying"],
        ["destroyed", "Destroyed"],
      ] as const) {
        const result = formatEnvironmentDisplay({
          environment: makeDisplayEnvironment({
            managed: true,
            isWorktree: true,
            workspaceProvisionType: "managed-worktree",
            path: null,
            status,
          }),
          host: localHostContext,
        });
        expect(result.modeLabel).toBe(label);
        expect(result.compactModeLabel).toBe(label);
      }
    });

    it("reports 'Provisioning' for a prepared managed worktree before the workspace path exists", () => {
      const result = formatEnvironmentDisplay({
        environment: makeDisplayEnvironment({
          status: "ready",
          path: null,
          workspaceProvisionType: "managed-worktree",
          isWorktree: false,
        }),
        host: remoteHostContext,
      });
      expect(result).toEqual({
        modeLabel: "Provisioning",
        compactModeLabel: "Provisioning",
        lifecycle: "provisioning",
        id: "env_test",
        mode: "direct",
        workspaceDisplayKind: "managed-worktree",
      });
    });

    it("reports 'Provisioning' for a local unmanaged env", () => {
      const result = formatEnvironmentDisplay({
        environment: makeDisplayEnvironment({ status: "provisioning" }),
        host: localHostContext,
      });
      expect(result.modeLabel).toBe("Provisioning");
      expect(result.compactModeLabel).toBe("Provisioning");
    });

    it("reports 'Provisioning' before local or remote display applies", () => {
      const result = formatEnvironmentDisplay({
        environment: makeDisplayEnvironment({ status: "provisioning" }),
        host: remoteHostContext,
      });
      expect(result).toEqual({
        modeLabel: "Provisioning",
        compactModeLabel: "Provisioning",
        lifecycle: "provisioning",
        id: "env_test",
        mode: "direct",
        workspaceDisplayKind: "other",
      });
    });
  });
});

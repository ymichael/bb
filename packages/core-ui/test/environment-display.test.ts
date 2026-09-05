import { describe, expect, it } from "vitest";
import type { Environment } from "@bb/domain";
import {
  formatEnvironmentDisplay,
  resolveEnvironmentDisplayName,
  type EnvironmentDisplayHostContext,
  type EnvironmentDisplayProvider,
  type EnvironmentDisplayProviderLookup,
} from "../src/environment-display.js";

const localHostContext: EnvironmentDisplayHostContext = {
  locality: "local",
  identity: null,
};

const remoteHostContext: EnvironmentDisplayHostContext = {
  locality: "remote",
  identity: null,
};

const worktreeProvider: EnvironmentDisplayProvider = {
  id: "git-worktree",
  displayName: "Worktree",
  icon: "FolderGit",
};

const worktreeProviderLookup: EnvironmentDisplayProviderLookup = {
  status: "loaded",
  provider: worktreeProvider,
};

const noProviderLookup: EnvironmentDisplayProviderLookup = {
  status: "loaded",
  provider: null,
};

const loadingProviderLookup: EnvironmentDisplayProviderLookup = {
  status: "loading",
};

function makeEnvironment(overrides?: Partial<Environment>): Environment {
  return {
    id: "env_test",
    name: null,
    projectId: "proj_test",
    hostId: "host_test",
    path: "/workspace",
    isGitRepo: true,
    isWorktree: false,
    baseBranch: null,
    branchName: null,
    defaultBranch: null,
    mergeBaseBranch: null,
    status: "ready",
    environmentProviderId: null,
    environmentProviderSelection: null,
    environmentProviderInstanceKey: null,
    lifecycle: { phase: "active", retireAt: null, teardown: null },
    managed: false,
    workspaceProvisionType: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("formatEnvironmentDisplay", () => {
  describe("label precedence", () => {
    it("falls back to the mode label for a project checkout with nothing to name", () => {
      expect(
        formatEnvironmentDisplay({
          environment: makeEnvironment(),
          host: localHostContext,
          providerLookup: noProviderLookup,
        }),
      ).toEqual({
        modeLabel: "Working locally",
        compactModeLabel: "Local",
        typeLabel: "Local",
        providerLabel: null,
        lifecycle: null,
        id: "env_test",
      });
    });

    it("falls back to the remote mode label on a remote machine", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment(),
        host: remoteHostContext,
        providerLookup: noProviderLookup,
      });
      expect(result.modeLabel).toBe("Working remotely");
      expect(result.compactModeLabel).toBe("Remote");
      expect(result.typeLabel).toBe("Remote");
    });

    it("labels a branch-bearing row by its provider, since the branch is shown beside it", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment({
          branchName: "bb/feature",
          environmentProviderId: "git-worktree",
        }),
        host: localHostContext,
        providerLookup: worktreeProviderLookup,
      });
      expect(result.modeLabel).toBe("Worktree");
      expect(result.compactModeLabel).toBe("Worktree");
      expect(result.typeLabel).toBe("Worktree · Local");
    });

    it("prefers the environment name over the branch name", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment({
          name: "Review workspace",
          branchName: "bb/feature",
          environmentProviderId: "git-worktree",
        }),
        host: localHostContext,
        providerLookup: worktreeProviderLookup,
      });
      expect(result.modeLabel).toBe("Review workspace");
      expect(result.compactModeLabel).toBe("Review workspace");
    });

    it("uses the provider display name when the row has no name or branch", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment({
          environmentProviderId: "modal-sandbox",
        }),
        host: remoteHostContext,
        providerLookup: {
          status: "loaded",
          provider: {
            id: "modal-sandbox",
            displayName: "Modal sandbox",
            icon: null,
          },
        },
      });
      expect(result.modeLabel).toBe("Modal sandbox");
      expect(result.compactModeLabel).toBe("Modal sandbox");
      expect(result.typeLabel).toBe("Modal sandbox · Remote");
    });

    it("falls back to the bare provider id when the plugin is not registered", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment({
          environmentProviderId: "modal-sandbox",
        }),
        host: remoteHostContext,
        providerLookup: noProviderLookup,
      });
      expect(result.modeLabel).toBe("modal-sandbox");
      expect(result.typeLabel).toBe("modal-sandbox · Remote");
      expect(result.providerLabel).toBe("modal-sandbox");
    });

    it("names nothing until the provider list has loaded", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment({
          environmentProviderId: "modal-sandbox",
        }),
        host: remoteHostContext,
        providerLookup: loadingProviderLookup,
      });
      expect(result.providerLabel).toBeNull();
      expect(result.modeLabel).toBe("Working remotely");
      expect(result.typeLabel).toBe("Remote");
    });
  });

  describe("lifecycle", () => {
    it("reports 'Provisioning' before the provider label applies", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment({
          status: "provisioning",
          environmentProviderId: "git-worktree",
          branchName: "bb/feature",
        }),
        host: remoteHostContext,
        providerLookup: worktreeProviderLookup,
      });
      expect(result.modeLabel).toBe("Provisioning");
      expect(result.compactModeLabel).toBe("Provisioning");
      expect(result.lifecycle).toBe("provisioning");
    });

    it("reports 'Destroyed' for a gone worktree instead of 'Provisioning' (#1789)", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment({
          path: null,
          status: "destroyed",
          environmentProviderId: "git-worktree",
        }),
        host: localHostContext,
        providerLookup: worktreeProviderLookup,
      });
      expect(result.modeLabel).toBe("Destroyed");
      expect(result.compactModeLabel).toBe("Destroyed");
      expect(result.lifecycle).toBe("destroyed");
    });

    it("keeps a custom name ahead of the lifecycle label", () => {
      const result = formatEnvironmentDisplay({
        environment: makeEnvironment({
          name: "Review workspace",
          status: "provisioning",
        }),
        host: localHostContext,
        providerLookup: noProviderLookup,
      });
      expect(result.modeLabel).toBe("Review workspace");
      expect(result.lifecycle).toBe("provisioning");
    });
  });
});

describe("resolveEnvironmentDisplayName", () => {
  it("returns null when a row has no name, branch or provider", () => {
    expect(
      resolveEnvironmentDisplayName(
        {
          name: null,
          branchName: null,
          path: null,
          environmentProviderId: null,
        },
        noProviderLookup,
      ),
    ).toBeNull();
  });

  it("returns the bare provider id for an unregistered provider", () => {
    expect(
      resolveEnvironmentDisplayName(
        {
          name: null,
          branchName: null,
          path: null,
          environmentProviderId: "modal-sandbox",
        },
        noProviderLookup,
      ),
    ).toBe("modal-sandbox");
  });

  it("returns null rather than the bare id while the provider list loads", () => {
    expect(
      resolveEnvironmentDisplayName(
        {
          name: null,
          branchName: null,
          path: null,
          environmentProviderId: "modal-sandbox",
        },
        loadingProviderLookup,
      ),
    ).toBeNull();
  });

  it("still names a loading row by its branch", () => {
    expect(
      resolveEnvironmentDisplayName(
        {
          name: null,
          branchName: "bb/feature",
          path: null,
          environmentProviderId: "modal-sandbox",
        },
        loadingProviderLookup,
      ),
    ).toBe("bb/feature");
  });

  it("names a branchless row by its folder before its provider", () => {
    expect(
      resolveEnvironmentDisplayName(
        {
          name: null,
          branchName: null,
          path: "/Users/bb/.bb/plugins/environment-personal-workspace/host-data/workspaces/thr_k72wqg7tcs/",
          environmentProviderId: "personal-workspace",
        },
        {
          status: "loaded",
          provider: {
            id: "personal-workspace",
            displayName: "Personal workspace",
            icon: null,
          },
        },
      ),
    ).toBe("thr_k72wqg7tcs");
    expect(
      resolveEnvironmentDisplayName(
        {
          name: null,
          branchName: null,
          path: "C:\\bb\\workspaces\\thr_win",
          environmentProviderId: "personal-workspace",
        },
        noProviderLookup,
      ),
    ).toBe("thr_win");
  });
});

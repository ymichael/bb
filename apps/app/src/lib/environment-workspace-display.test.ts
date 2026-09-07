import { describe, expect, it } from "vitest";
import {
  getEnvironmentWorkspaceSummaryDisplay,
  getEnvironmentWorkspaceTypeLabel,
} from "./environment-workspace-display";

describe("getEnvironmentWorkspaceTypeLabel", () => {
  it.each([
    ["managed-worktree", "local", "Local worktree"],
    ["unmanaged-worktree", "remote", "Remote worktree"],
    ["other", "local", "Local"],
    ["other", "remote", "Remote"],
  ] as const)("maps %s on a %s host to %s", (kind, locality, expected) => {
    expect(getEnvironmentWorkspaceTypeLabel(kind, locality)).toBe(expected);
  });
});

describe("getEnvironmentWorkspaceSummaryDisplay", () => {
  it("keeps provisioning ahead of host and worktree classification", () => {
    expect(
      getEnvironmentWorkspaceSummaryDisplay({
        display: {
          modeLabel: "Provisioning",
          compactModeLabel: "Provisioning",
          lifecycle: "provisioning",
          id: "env_test",
          mode: "direct",
          workspaceDisplayKind: "managed-worktree",
        },
        environmentName: null,
        locality: "remote",
        hostName: "Remote builder",
      }),
    ).toEqual({
      label: "Provisioning",
      compactLabel: "Provisioning",
      icon: "Loading",
      typeLabel: undefined,
    });
  });

  it("uses the host for a worktree without a custom name", () => {
    expect(
      getEnvironmentWorkspaceSummaryDisplay({
        display: {
          modeLabel: "Worktree",
          compactModeLabel: "Worktree",
          lifecycle: null,
          id: "env_test",
          mode: "worktree",
          workspaceDisplayKind: "managed-worktree",
        },
        environmentName: null,
        locality: "remote",
        hostName: "Build Mac mini",
        machinePrefix: "Build Mac mini · ",
      }),
    ).toMatchObject({
      label: "Build Mac mini",
      compactLabel: "Build Mac mini",
      icon: "FolderGit",
      typeLabel: "Remote worktree",
    });
  });

  it("preserves a real custom worktree name", () => {
    expect(
      getEnvironmentWorkspaceSummaryDisplay({
        display: {
          modeLabel: "Design system polish",
          compactModeLabel: "Design system polish",
          lifecycle: null,
          id: "env_test",
          mode: "worktree",
          workspaceDisplayKind: "managed-worktree",
        },
        environmentName: "Design system polish",
        locality: "remote",
        hostName: "Build Mac mini",
        machinePrefix: "Build Mac mini · ",
      }),
    ).toMatchObject({
      label: "Build Mac mini · Design system polish",
      compactLabel: "Design system polish",
    });
  });
});

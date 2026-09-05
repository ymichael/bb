import { describe, expect, it } from "vitest";
import {
  resolveEnvironmentWorkspaceDisplayKind,
  toEnvironmentResponse,
} from "../../../src/services/environments/environment-response.js";
import type { EnvironmentRow } from "@bb/db";

function makeRow(overrides: Partial<EnvironmentRow> = {}): EnvironmentRow {
  return {
    id: "env_1",
    name: null,
    projectId: "proj_1",
    hostId: "host_1",
    path: "/tmp/workspace",
    isGitRepo: true,
    isWorktree: false,
    branchName: "main",
    baseBranch: null,
    defaultBranch: "main",
    mergeBaseBranch: null,
    environmentProviderId: null,
    environmentProviderSelection: null,
    environmentProviderInstanceKey: null,
    providerOwnsPath: false,
    retireAt: null,
    teardownAttempt: 0,
    teardownStatus: null,
    teardownMessage: null,
    resource: null,
    status: "ready",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("resolveEnvironmentWorkspaceDisplayKind", () => {
  it.each([
    ["git-worktree", false, "managed-worktree"],
    ["git-worktree", true, "managed-worktree"],
    ["personal-workspace", false, "other"],
    ["personal-workspace", true, "unmanaged-worktree"],
    ["project-checkout", false, "other"],
    ["project-checkout", true, "unmanaged-worktree"],
    ["modal-sandbox", false, "other"],
    ["modal-sandbox", true, "unmanaged-worktree"],
  ] as const)(
    "reports %s with isWorktree %s as %s",
    (environmentProviderId, isWorktree, expected) => {
      expect(
        resolveEnvironmentWorkspaceDisplayKind({
          environmentProviderId,
          isWorktree,
        }),
      ).toBe(expected);
    },
  );

  it("reports a row no provider produced by its directory alone", () => {
    expect(
      resolveEnvironmentWorkspaceDisplayKind({
        environmentProviderId: null,
        isWorktree: true,
      }),
    ).toBe("unmanaged-worktree");
    expect(
      resolveEnvironmentWorkspaceDisplayKind({
        environmentProviderId: null,
        isWorktree: false,
      }),
    ).toBe("other");
  });

  it("reports other when there is no environment", () => {
    expect(
      resolveEnvironmentWorkspaceDisplayKind({
        environmentProviderId: null,
        isWorktree: null,
      }),
    ).toBe("other");
  });
});

describe("toEnvironmentResponse", () => {
  it.each([
    ["git-worktree", "managed-worktree"],
    ["personal-workspace", "personal"],
    ["project-checkout", "unmanaged"],
    ["modal-sandbox", null],
  ] as const)(
    "derives workspaceProvisionType %s as %s",
    (environmentProviderId, expected) => {
      expect(
        toEnvironmentResponse(makeRow({ environmentProviderId })),
      ).toMatchObject({ workspaceProvisionType: expected });
    },
  );

  it("publishes the row's ownership fact as the deprecated managed flag", () => {
    expect(
      toEnvironmentResponse(makeRow({ providerOwnsPath: true })).managed,
    ).toBe(true);
    expect(
      toEnvironmentResponse(makeRow({ providerOwnsPath: false })).managed,
    ).toBe(false);
  });

  it("does not leak the row's internal ownership column", () => {
    expect(toEnvironmentResponse(makeRow())).not.toHaveProperty(
      "providerOwnsPath",
    );
  });
});

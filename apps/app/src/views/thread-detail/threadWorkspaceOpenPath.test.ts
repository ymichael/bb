import type {
  Environment,
  WorkspaceFileStatus,
  WorkspaceFileStatusKind,
} from "@bb/domain";
import type { WorkspaceChangedFilesSection } from "@/components/workspace/workspace-change-summary";
import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceChangedFileOpenTarget,
  resolveThreadLocalWorkspaceRootPath,
  resolveThreadWorkspaceOpenPath,
} from "./threadWorkspaceOpenPath";

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    baseBranch: null,
    branchName: "feature/test",
    cleanupMode: null,
    cleanupRequestedAt: null,
    createdAt: 1,
    defaultBranch: "main",
    hostId: "host-1",
    id: "environment-1",
    isGitRepo: true,
    isWorktree: true,
    managed: true,
    mergeBaseBranch: "main",
    path: "/tmp/workspace",
    projectId: "project-1",
    status: "ready",
    updatedAt: 1,
    workspaceProvisionType: "managed-worktree",
    ...overrides,
  };
}

function makeWorkspaceFileStatus(
  status: WorkspaceFileStatusKind,
): WorkspaceFileStatus {
  return {
    path: "src/file.ts",
    status,
  };
}

function makeWorkspaceChangedFilesSection(
  overrides: Partial<WorkspaceChangedFilesSection> = {},
): WorkspaceChangedFilesSection {
  const file = makeWorkspaceFileStatus("M");
  return {
    kind: "uncommitted",
    label: "Uncommitted files",
    files: [file],
    mergeBaseRef: null,
    stats: {
      files: [file],
      insertions: 1,
      deletions: 1,
    },
    ...overrides,
  };
}

describe("resolveThreadWorkspaceOpenPath", () => {
  it("resolves the ready local workspace root path", () => {
    expect(
      resolveThreadLocalWorkspaceRootPath({
        environment: makeEnvironment(),
        threadEnvironmentIsLocal: true,
      }),
    ).toBe("/tmp/workspace");
  });

  it("returns the ready local environment path when the capability is available", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeEnvironment(),
        hasWorkspaceOpenTargets: true,
        threadEnvironmentIsLocal: true,
      }),
    ).toBe("/tmp/workspace");
  });

  it("hides when the environment is remote", () => {
    expect(
      resolveThreadLocalWorkspaceRootPath({
        environment: makeEnvironment(),
        threadEnvironmentIsLocal: false,
      }),
    ).toBeNull();
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeEnvironment(),
        hasWorkspaceOpenTargets: true,
        threadEnvironmentIsLocal: false,
      }),
    ).toBeNull();
  });

  it("still resolves when the environment is not ready, as long as it has a path", () => {
    expect(
      resolveThreadLocalWorkspaceRootPath({
        environment: makeEnvironment({ status: "destroyed" }),
        threadEnvironmentIsLocal: true,
      }),
    ).toBe("/tmp/workspace");
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeEnvironment({ status: "destroyed" }),
        hasWorkspaceOpenTargets: true,
        threadEnvironmentIsLocal: true,
      }),
    ).toBe("/tmp/workspace");
  });

  it("hides when the environment has no path", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeEnvironment({ path: null }),
        hasWorkspaceOpenTargets: true,
        threadEnvironmentIsLocal: true,
      }),
    ).toBeNull();
  });

  it("hides when the daemon capability is unavailable", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: false,
        environment: makeEnvironment(),
        hasWorkspaceOpenTargets: true,
        threadEnvironmentIsLocal: true,
      }),
    ).toBeNull();
  });

  it("hides when there are no available targets", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeEnvironment(),
        hasWorkspaceOpenTargets: false,
        threadEnvironmentIsLocal: true,
      }),
    ).toBeNull();
  });
});

describe("resolveWorkspaceChangedFileOpenTarget", () => {
  it("opens added and untracked files as previews", () => {
    expect(
      resolveWorkspaceChangedFileOpenTarget({
        file: makeWorkspaceFileStatus("A"),
        section: makeWorkspaceChangedFilesSection(),
      }),
    ).toEqual({
      kind: "preview",
      source: { kind: "working-tree" },
      statusLabel: null,
    });
    expect(
      resolveWorkspaceChangedFileOpenTarget({
        file: makeWorkspaceFileStatus("??"),
        section: makeWorkspaceChangedFilesSection({ kind: "untracked" }),
      }),
    ).toEqual({
      kind: "preview",
      source: { kind: "working-tree" },
      statusLabel: null,
    });
  });

  it("opens working-tree deleted files as HEAD previews because the current file no longer exists", () => {
    expect(
      resolveWorkspaceChangedFileOpenTarget({
        file: makeWorkspaceFileStatus("D"),
        section: makeWorkspaceChangedFilesSection(),
      }),
    ).toEqual({
      kind: "preview",
      source: { kind: "head" },
      statusLabel: "deleted",
    });
  });

  it("opens committed deleted files as merge-base previews when the merge-base ref is known", () => {
    expect(
      resolveWorkspaceChangedFileOpenTarget({
        file: makeWorkspaceFileStatus("D"),
        section: makeWorkspaceChangedFilesSection({
          kind: "committed",
          mergeBaseRef: "abc1234",
        }),
      }),
    ).toEqual({
      kind: "preview",
      source: { kind: "merge-base", ref: "abc1234" },
      statusLabel: "deleted",
    });
  });

  it("opens committed deleted files as diffs when the merge-base ref is unknown", () => {
    expect(
      resolveWorkspaceChangedFileOpenTarget({
        file: makeWorkspaceFileStatus("D"),
        section: makeWorkspaceChangedFilesSection({
          kind: "committed",
          mergeBaseRef: null,
        }),
      }),
    ).toEqual({ kind: "diff" });
  });

  it("opens modified, copied, renamed, conflicted, and unknown statuses as diffs", () => {
    expect(
      resolveWorkspaceChangedFileOpenTarget({
        file: makeWorkspaceFileStatus("M"),
        section: makeWorkspaceChangedFilesSection(),
      }),
    ).toEqual({ kind: "diff" });
    expect(
      resolveWorkspaceChangedFileOpenTarget({
        file: makeWorkspaceFileStatus("C"),
        section: makeWorkspaceChangedFilesSection(),
      }),
    ).toEqual({ kind: "diff" });
    expect(
      resolveWorkspaceChangedFileOpenTarget({
        file: makeWorkspaceFileStatus("R"),
        section: makeWorkspaceChangedFilesSection(),
      }),
    ).toEqual({ kind: "diff" });
    expect(
      resolveWorkspaceChangedFileOpenTarget({
        file: makeWorkspaceFileStatus("U"),
        section: makeWorkspaceChangedFilesSection(),
      }),
    ).toEqual({ kind: "diff" });
    expect(
      resolveWorkspaceChangedFileOpenTarget({
        file: makeWorkspaceFileStatus("?"),
        section: makeWorkspaceChangedFilesSection(),
      }),
    ).toEqual({ kind: "diff" });
  });
});

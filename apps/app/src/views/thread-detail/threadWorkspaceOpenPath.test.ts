import type {
  Environment,
  WorkspaceFileStatus,
  WorkspaceFileStatusKind,
} from "@bb/domain";
import type { WorkspaceChangedFilesSection } from "@/components/workspace/workspace-change-summary";
import { makeEnvironment } from "@bb/test-helpers/domain-fixtures";
import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceChangedFileOpenTarget,
  resolveEnvironmentOpenContext,
  resolveThreadWorkspaceOpenPath,
} from "./threadWorkspaceOpenPath";

function makeWorkspaceEnvironment(
  overrides: Partial<Environment> = {},
): Environment {
  return makeEnvironment({
    baseBranch: null,
    branchName: "feature/test",
    createdAt: 1,
    hostId: "host-1",
    id: "environment-1",
    mergeBaseBranch: "main",
    path: "/tmp/workspace",
    projectId: "project-1",
    updatedAt: 1,
    ...overrides,
  });
}

function makeWorkspaceFileStatus(
  status: WorkspaceFileStatusKind,
): WorkspaceFileStatus {
  return {
    path: "src/file.ts",
    status,
    insertions: null,
    deletions: null,
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
      lineStatsComplete: true,
    },
    ...overrides,
  };
}

describe("resolveThreadWorkspaceOpenPath", () => {
  it("resolves local and remote editor contexts", () => {
    expect(
      resolveEnvironmentOpenContext({
        environment: makeWorkspaceEnvironment({ hostId: "host-local" }),
        serverOrigin: "https://bb.example.test",
        threadEnvironmentIsLocal: true,
      }),
    ).toEqual({ kind: "local" });
    expect(
      resolveEnvironmentOpenContext({
        environment: makeWorkspaceEnvironment({ hostId: "host-remote" }),
        serverOrigin: "https://bb.example.test",
        threadEnvironmentIsLocal: false,
      }),
    ).toEqual({
      kind: "remote-ssh",
      serverOrigin: "https://bb.example.test",
      hostId: "host-remote",
    });
  });

  it("returns the ready local environment path when the capability is available", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeWorkspaceEnvironment(),
        hasWorkspaceOpenTargets: true,
      }),
    ).toBe("/tmp/workspace");
  });

  it("hides when workspace open preconditions are missing", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeWorkspaceEnvironment(),
        hasWorkspaceOpenTargets: true,
      }),
    ).toBe("/tmp/workspace");
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeWorkspaceEnvironment({ path: null }),
        hasWorkspaceOpenTargets: true,
      }),
    ).toBeNull();
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: false,
        environment: makeWorkspaceEnvironment(),
        hasWorkspaceOpenTargets: true,
      }),
    ).toBeNull();
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeWorkspaceEnvironment(),
        hasWorkspaceOpenTargets: false,
      }),
    ).toBeNull();
  });

  it("still resolves when the environment is not ready, as long as it has a path", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeWorkspaceEnvironment({ status: "destroyed" }),
        hasWorkspaceOpenTargets: true,
      }),
    ).toBe("/tmp/workspace");
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

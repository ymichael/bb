import type { WorkspaceOpenTarget } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { resolvePreferredWorkspaceOpenTarget } from "./workspace-open-target-preference";

const TARGETS: WorkspaceOpenTarget[] = [
  {
    id: "finder",
    kind: "file-browser",
    label: "Finder",
  },
  {
    id: "vscode",
    kind: "editor",
    label: "VS Code",
  },
];

describe("resolvePreferredWorkspaceOpenTarget", () => {
  it("uses the stored target when it is available", () => {
    expect(
      resolvePreferredWorkspaceOpenTarget({
        preferredTargetId: "finder",
        targets: TARGETS,
      }),
    ).toEqual({
      id: "finder",
      kind: "file-browser",
      label: "Finder",
    });
  });

  it("falls back to an editor target when no preference is stored", () => {
    expect(
      resolvePreferredWorkspaceOpenTarget({
        preferredTargetId: null,
        targets: TARGETS,
      }),
    ).toEqual({
      id: "vscode",
      kind: "editor",
      label: "VS Code",
    });
  });

  it("falls back to an editor without requiring the unavailable preference to be rewritten", () => {
    expect(
      resolvePreferredWorkspaceOpenTarget({
        preferredTargetId: "cursor",
        targets: TARGETS,
      }),
    ).toEqual({
      id: "vscode",
      kind: "editor",
      label: "VS Code",
    });
  });

  it("falls back to the first target when no editor target is available", () => {
    expect(
      resolvePreferredWorkspaceOpenTarget({
        preferredTargetId: null,
        targets: [
          {
            id: "finder",
            kind: "file-browser",
            label: "Finder",
          },
          {
            id: "terminal",
            kind: "terminal",
            label: "Terminal",
          },
        ],
      }),
    ).toEqual({
      id: "finder",
      kind: "file-browser",
      label: "Finder",
    });
  });

  it("returns null when there are no available targets", () => {
    expect(
      resolvePreferredWorkspaceOpenTarget({
        preferredTargetId: "vscode",
        targets: [],
      }),
    ).toBeNull();
  });
});

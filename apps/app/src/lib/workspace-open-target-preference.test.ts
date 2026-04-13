import type { WorkspaceOpenTarget } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { resolvePreferredWorkspaceOpenTarget } from "./workspace-open-target-preference";

const TARGETS: WorkspaceOpenTarget[] = [
  {
    id: "vscode",
    label: "VS Code",
  },
  {
    id: "finder",
    label: "Finder",
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
      label: "Finder",
    });
  });

  it("falls back to the first target when no preference is stored", () => {
    expect(
      resolvePreferredWorkspaceOpenTarget({
        preferredTargetId: null,
        targets: TARGETS,
      }),
    ).toEqual({
      id: "vscode",
      label: "VS Code",
    });
  });

  it("falls back without requiring the unavailable preference to be rewritten", () => {
    expect(
      resolvePreferredWorkspaceOpenTarget({
        preferredTargetId: "cursor",
        targets: TARGETS,
      }),
    ).toEqual({
      id: "vscode",
      label: "VS Code",
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

// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useScopedBranchSelection } from "./root-compose-branch-selection";

describe("new-thread branch selection navigation", () => {
  it("keeps the worktree base branch after the composer remounts", () => {
    const args = {
      environmentValue: "host:host_1:worktree",
      projectId: "proj_1",
      selectionScope: "new-thread" as const,
    };
    const first = renderHook(() => useScopedBranchSelection(args));

    act(() => first.result.current.onBranchChange("origin/release"));
    expect(first.result.current.selectedBranch?.name).toBe("origin/release");
    first.unmount();

    const second = renderHook(
      ({ environmentValue }) =>
        useScopedBranchSelection({ ...args, environmentValue }),
      { initialProps: { environmentValue: args.environmentValue } },
    );
    expect(second.result.current.selectedBranch?.name).toBe("origin/release");

    second.rerender({ environmentValue: "host:host_1:local" });
    expect(second.result.current.selectedBranch).toBeNull();
  });

  it("does not retain component-local branch selection after a remount", () => {
    const args = {
      environmentValue: "host:host_1:worktree",
      projectId: "proj_plugin",
      selectionScope: "component-local" as const,
    };
    const first = renderHook(() => useScopedBranchSelection(args));

    act(() => first.result.current.onBranchChange("origin/release"));
    first.unmount();

    const second = renderHook(() => useScopedBranchSelection(args));
    expect(second.result.current.selectedBranch).toBeNull();
  });
});

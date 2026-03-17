import { describe, expect, it } from "vitest";
import {
  formatEnvironmentDisplayName,
  isWorktreeEnvironmentReference,
} from "../src/environment-display-name.js";

describe("formatEnvironmentDisplayName", () => {
  it("maps built-in environment ids to concise labels", () => {
    expect(formatEnvironmentDisplayName({ id: "local" })).toBe("Direct");
    expect(formatEnvironmentDisplayName({ id: "worktree" })).toBe("Worktree");
    expect(formatEnvironmentDisplayName({ id: "docker" })).toBe("Docker Sandbox");
  });

  it("normalizes legacy built-in display names", () => {
    expect(
      formatEnvironmentDisplayName({ displayName: "Local Workspace" }),
    ).toBe("Direct");
    expect(
      formatEnvironmentDisplayName({ displayName: "Direct Workspace" }),
    ).toBe("Direct");
    expect(
      formatEnvironmentDisplayName({ displayName: "Git Worktree Workspace" }),
    ).toBe("Worktree");
  });

  it("preserves unknown runtime-provided names", () => {
    expect(
      formatEnvironmentDisplayName({
        id: "remote",
        displayName: "Remote Sandbox",
      }),
    ).toBe("Remote Sandbox");
  });

  it("detects worktree references from runtime ids and legacy display names", () => {
    expect(isWorktreeEnvironmentReference({ id: "worktree" })).toBe(true);
    expect(
      isWorktreeEnvironmentReference({ displayName: "Git Worktree Workspace" }),
    ).toBe(true);
    expect(isWorktreeEnvironmentReference({ displayName: "Worktree" })).toBe(true);
    expect(isWorktreeEnvironmentReference({ id: "docker" })).toBe(false);
  });
});

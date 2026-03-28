import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchCommand } from "../../src/command-dispatch.js";
import { cleanupTempDirs, createHarness, makeTempDir } from "./dispatch-helpers.js";

afterEach(cleanupTempDirs);

describe("workspace command dispatch", () => {
  it("covers workspace git commands", async () => {
    const harness = createHarness();
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const statusResult = await dispatchCommand(
      {
        type: "workspace.status",
        environmentId: "env-1",
        environmentStatus: "ready",
        workspacePath: "/tmp/env-1",
        threadId: "thread-1",
        mergeBaseBranch: "main",
      },
      { runtimeManager: harness.manager },
    );
    const diffResult = await dispatchCommand(
      {
        type: "workspace.diff",
        environmentId: "env-1",
        environmentStatus: "ready",
        workspacePath: "/tmp/env-1",
        threadId: "thread-1",
        mergeBaseBranch: "main",
        selection: { type: "combined" },
      },
      { runtimeManager: harness.manager },
    );
    const commitResult = await dispatchCommand(
      {
        type: "workspace.commit",
        environmentId: "env-1",
        environmentStatus: "ready",
        workspacePath: "/tmp/env-1",
        threadId: "thread-1",
        message: "Commit message",
      },
      { runtimeManager: harness.manager },
    );
    const squashResult = await dispatchCommand(
      {
        type: "workspace.squash_merge",
        environmentId: "env-1",
        environmentStatus: "ready",
        workspacePath: "/tmp/env-1",
        threadId: "thread-1",
        targetBranch: "main",
      },
      { runtimeManager: harness.manager },
    );
    const resetResult = await dispatchCommand(
      {
        type: "workspace.reset",
        environmentId: "env-1",
        environmentStatus: "ready",
        workspacePath: "/tmp/env-1",
        threadId: "thread-1",
      },
      { runtimeManager: harness.manager },
    );
    const checkpointResult = await dispatchCommand(
      {
        type: "workspace.checkpoint",
        environmentId: "env-1",
        environmentStatus: "ready",
        workspacePath: "/tmp/env-1",
        threadId: "thread-1",
        commitMessage: "Checkpoint",
      },
      { runtimeManager: harness.manager },
    );
    const promoteResult = await dispatchCommand(
      {
        type: "workspace.promote",
        environmentId: "env-1",
        environmentStatus: "ready",
        workspacePath: "/tmp/env-1",
        threadId: "thread-1",
        primaryPath: "/tmp/primary",
      },
      { runtimeManager: harness.manager },
    );
    const demoteResult = await dispatchCommand(
      {
        type: "workspace.demote",
        environmentId: "env-1",
        environmentStatus: "ready",
        workspacePath: "/tmp/env-1",
        threadId: "thread-1",
        primaryPath: "/tmp/primary",
        defaultBranch: "main",
        envBranch: "feature",
      },
      { runtimeManager: harness.manager },
    );

    expect(statusResult.workspaceStatus?.state).toBe("clean");
    expect(diffResult.diff.diff).toBe("");
    expect(commitResult).toEqual({ commitSha: "commit-1", commitSubject: "Commit message" });
    expect(squashResult).toEqual({ merged: true, commitSha: "merge-main" });
    expect(resetResult).toEqual({});
    expect(checkpointResult).toEqual({ commitSha: "checkpoint-1", branchName: "main", remoteName: "origin" });
    expect(promoteResult).toEqual({ ok: true });
    expect(demoteResult).toEqual({ ok: true });
    expect(harness.workspaceState.statusReads).toBe(1);
    expect(harness.workspaceState.lastCommitMessage).toBe("Commit message");
    expect(harness.workspaceState.resetCount).toBe(1);
    expect(harness.workspaceState.promotedPrimaryPath).toBe("/tmp/primary");
    expect(harness.workspaceState.demotedPrimaryPath).toBe("/tmp/primary");
  });

  it("rehydrates a missing workspace runtime from workspacePath", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-rehydrate" });

    const result = await dispatchCommand(
      {
        type: "workspace.status",
        environmentId: "env-rehydrate",
        environmentStatus: "ready",
        workspacePath: "/tmp/env-rehydrate",
        threadId: "thread-1",
        mergeBaseBranch: "main",
      },
      { runtimeManager: harness.manager },
    );

    expect(result.workspaceStatus?.state).toBe("clean");
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "unmanaged",
        path: "/tmp/env-rehydrate",
      },
    ]);
  });

  it("covers workspace.list_files", async () => {
    const tempDir = await makeTempDir("bb-dispatch-list-files-");
    await fs.writeFile(path.join(tempDir, "file-a.txt"), "hello");
    await fs.mkdir(path.join(tempDir, "sub"));
    await fs.writeFile(path.join(tempDir, "sub", "file-b.ts"), "world");

    const harness = createHarness({ workspacePath: tempDir });
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: tempDir,
    });

    const result = await dispatchCommand(
      {
        type: "workspace.list_files",
        environmentId: "env-1",
        environmentStatus: "ready",
        workspacePath: tempDir,
      },
      { runtimeManager: harness.manager },
    );

    const paths = result.files.map((f: { path: string }) => f.path).sort();
    expect(paths).toContain("file-a.txt");
    expect(paths).toContain(path.join("sub", "file-b.ts"));

    const filtered = await dispatchCommand(
      {
        type: "workspace.list_files",
        environmentId: "env-1",
        environmentStatus: "ready",
        workspacePath: tempDir,
        query: "file-b",
      },
      { runtimeManager: harness.manager },
    );
    expect(filtered.files).toHaveLength(1);
    expect(filtered.files[0].name).toBe("file-b.ts");
  });

  it("covers workspace.read_file", async () => {
    const tempDir = await makeTempDir("bb-dispatch-read-file-");
    await fs.writeFile(path.join(tempDir, "readme.txt"), "contents here");

    const harness = createHarness({ workspacePath: tempDir });
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: tempDir,
    });

    const result = await dispatchCommand(
      {
        type: "workspace.read_file",
        environmentId: "env-1",
        environmentStatus: "ready",
        workspacePath: tempDir,
        path: "readme.txt",
      },
      { runtimeManager: harness.manager },
    );

    expect(result.path).toBe("readme.txt");
    expect(result.content).toBe("contents here");
  });

  it("rejects workspace.read_file with path traversal", async () => {
    const tempDir = await makeTempDir("bb-dispatch-read-escape-");
    const harness = createHarness({ workspacePath: tempDir });
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: tempDir,
    });

    await expect(
      dispatchCommand(
        {
          type: "workspace.read_file",
          environmentId: "env-1",
          environmentStatus: "ready",
          workspacePath: tempDir,
          path: "../../../etc/passwd",
        },
        { runtimeManager: harness.manager },
      ),
    ).rejects.toThrow("escapes workspace root");
  });

  it("covers workspace.list_branches", async () => {
    const harness = createHarness();
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const result = await dispatchCommand(
      {
        type: "workspace.list_branches",
        environmentId: "env-1",
        environmentStatus: "ready",
        workspacePath: "/tmp/env-1",
      },
      { runtimeManager: harness.manager },
    );

    expect(result.branches).toEqual(["main"]);
    expect(result.current).toBe("main");
  });
});

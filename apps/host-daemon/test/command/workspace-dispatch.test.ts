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
        workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
        mergeBaseBranch: "main",
      },
      { runtimeManager: harness.manager },
    );
    const diffResult = await dispatchCommand(
      {
        type: "workspace.diff",
        environmentId: "env-1",
        workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
        target: { type: "all", mergeBaseBranch: "main" },
      },
      { runtimeManager: harness.manager },
    );
    const commitResult = await dispatchCommand(
      {
        type: "workspace.commit",
        environmentId: "env-1",
        workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
        message: "Commit message",
      },
      { runtimeManager: harness.manager },
    );
    const squashResult = await dispatchCommand(
      {
        type: "workspace.squash_merge",
        environmentId: "env-1",
        workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
        targetBranch: "main",
        commitMessage: "feat: squash merge",
      },
      { runtimeManager: harness.manager },
    );
    const checkpointResult = await dispatchCommand(
      {
        type: "workspace.checkpoint",
        environmentId: "env-1",
        workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
        commitMessage: "Checkpoint",
      },
      { runtimeManager: harness.manager },
    );
    const promoteResult = await dispatchCommand(
      {
        type: "workspace.promote",
        environmentId: "env-1",
        workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
        threadId: "thread-1",
        primaryPath: "/tmp/primary",
      },
      { runtimeManager: harness.manager },
    );
    const demoteResult = await dispatchCommand(
      {
        type: "workspace.demote",
        environmentId: "env-1",
        workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
        threadId: "thread-1",
        primaryPath: "/tmp/primary",
        defaultBranch: "main",
        envBranch: "feature",
      },
      { runtimeManager: harness.manager },
    );

    expect(statusResult.workspaceStatus?.workingTree.state).toBe("clean");
    expect(diffResult.diff.diff).toBe("");
    expect(commitResult).toEqual({ commitSha: "commit-1", commitSubject: "Commit message" });
    expect(squashResult).toEqual({ merged: true, commitSha: "merge-main" });
    expect(checkpointResult).toEqual({ commitSha: "checkpoint-1", branchName: "main", remoteName: "origin" });
    expect(promoteResult).toEqual({ ok: true });
    expect(demoteResult).toEqual({ ok: true });
    expect(harness.workspaceState.statusReads).toBe(1);
    expect(harness.workspaceState.lastCommitMessage).toBe("Commit message");
    expect(harness.workspaceState.promotedPrimaryPath).toBe("/tmp/primary");
    expect(harness.workspaceState.demotedPrimaryPath).toBe("/tmp/primary");
  });

  it("rehydrates a missing workspace runtime from workspaceContext", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-rehydrate" });

    const result = await dispatchCommand(
      {
        type: "workspace.status",
        environmentId: "env-rehydrate",
        workspaceContext: { workspacePath: "/tmp/env-rehydrate", workspaceProvisionType: "unmanaged" },
      },
      { runtimeManager: harness.manager },
    );

    expect(result.workspaceStatus?.workingTree.state).toBe("clean");
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
        workspaceContext: { workspacePath: tempDir, workspaceProvisionType: "unmanaged" },
        limit: 1000,
      },
      { runtimeManager: harness.manager },
    );

    const paths = result.files.map((f: { path: string }) => f.path).sort();
    expect(paths).toContain("file-a.txt");
    expect(paths).toContain(path.join("sub", "file-b.ts"));
    expect(result.truncated).toBe(false);

    const filtered = await dispatchCommand(
      {
        type: "workspace.list_files",
        environmentId: "env-1",
        workspaceContext: { workspacePath: tempDir, workspaceProvisionType: "unmanaged" },
        query: "file-b",
        limit: 1000,
      },
      { runtimeManager: harness.manager },
    );
    expect(filtered.files).toHaveLength(1);
    expect(filtered.files[0].name).toBe("file-b.ts");
    expect(filtered.truncated).toBe(false);

    const limited = await dispatchCommand(
      {
        type: "workspace.list_files",
        environmentId: "env-1",
        workspaceContext: { workspacePath: tempDir, workspaceProvisionType: "unmanaged" },
        limit: 1,
      },
      { runtimeManager: harness.manager },
    );
    expect(limited.files).toHaveLength(1);
    expect(limited.truncated).toBe(true);
  });

  it("covers host.list_files", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-list-files-");
    await fs.writeFile(path.join(tempDir, "PREFERENCES.md"), "hello");
    await fs.mkdir(path.join(tempDir, "notes"));
    await fs.writeFile(path.join(tempDir, "notes", "todo.md"), "world");

    const harness = createHarness();
    const result = await dispatchCommand(
      {
        type: "host.list_files",
        path: tempDir,
        limit: 1000,
      },
      { runtimeManager: harness.manager },
    );

    const paths = result.files.map((file) => file.path).sort();
    expect(paths).toEqual([
      "PREFERENCES.md",
      path.join("notes", "todo.md"),
    ]);
    expect(result.truncated).toBe(false);
  });

  it("rejects host.list_files when path itself is a symlink", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-list-symlink-root-");
    const targetRoot = path.join(tempDir, "target-root");
    const symlinkRoot = path.join(tempDir, "root-link");
    await fs.mkdir(targetRoot);
    await fs.writeFile(path.join(targetRoot, "notes.txt"), "hello");
    await fs.symlink(targetRoot, symlinkRoot);

    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "host.list_files",
          path: symlinkRoot,
          limit: 1000,
        },
        { runtimeManager: harness.manager },
      ),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("must not be a symlink"),
    });
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
        workspaceContext: { workspacePath: tempDir, workspaceProvisionType: "unmanaged" },
        path: "readme.txt",
      },
      { runtimeManager: harness.manager },
    );

    expect(result.path).toBe("readme.txt");
    expect(result.content).toBe("contents here");
    expect(result.contentEncoding).toBe("utf8");
    expect(result.sizeBytes).toBe("contents here".length);
  });

  it("covers host.read_file", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-file-");
    const filePath = path.join(tempDir, "PREFERENCES.md");
    await fs.writeFile(filePath, "durable manager notes");

    const harness = createHarness();
    const result = await dispatchCommand(
      {
        type: "host.read_file",
        path: filePath,
        rootPath: tempDir,
      },
      { runtimeManager: harness.manager },
    );

    expect(result.path).toBe(filePath);
    expect(result.content).toBe("durable manager notes");
    expect(result.contentEncoding).toBe("utf8");
    expect(result.sizeBytes).toBe("durable manager notes".length);
  });

  it("returns base64 for image files", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-image-");
    const imagePath = path.join(tempDir, "preview.png");
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await fs.writeFile(imagePath, imageBytes);

    const harness = createHarness();
    const result = await dispatchCommand(
      {
        type: "host.read_file",
        path: imagePath,
        rootPath: tempDir,
      },
      { runtimeManager: harness.manager },
    );

    expect(result.path).toBe(imagePath);
    expect(result.content).toBe(imageBytes.toString("base64"));
    expect(result.contentEncoding).toBe("base64");
    expect(result.mimeType).toBe("image/png");
    expect(result.sizeBytes).toBe(imageBytes.length);
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
          workspaceContext: { workspacePath: tempDir, workspaceProvisionType: "unmanaged" },
          path: "../../../etc/passwd",
        },
        { runtimeManager: harness.manager },
      ),
    ).rejects.toThrow("escapes workspace root");
  });

  it("rejects host.read_file with a relative path", async () => {
    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "host.read_file",
          path: "PREFERENCES.md",
          rootPath: "/tmp",
        },
        { runtimeManager: harness.manager },
      ),
    ).rejects.toThrow("Path must be absolute");
  });

  it("normalizes missing host.read_file paths to ENOENT", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-missing-");
    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "host.read_file",
          path: path.join(tempDir, "missing.md"),
          rootPath: tempDir,
        },
        { runtimeManager: harness.manager },
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
      message: expect.stringContaining("Path does not exist"),
    });
  });

  it("rejects host.read_file when the resolved path escapes rootPath through a symlink", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-root-escape-");
    const outsidePath = path.join(tempDir, "..", "outside.txt");
    const nestedDir = path.join(tempDir, "notes");
    const symlinkPath = path.join(nestedDir, "secrets");
    await fs.writeFile(outsidePath, "outside");
    await fs.mkdir(nestedDir);
    await fs.symlink(outsidePath, symlinkPath);

    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "host.read_file",
          path: symlinkPath,
          rootPath: tempDir,
        },
        { runtimeManager: harness.manager },
      ),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("escapes read root"),
    });
  });

  it("rejects host.read_file when rootPath itself is a symlink", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-root-symlink-");
    const targetRoot = path.join(tempDir, "target-root");
    const symlinkRoot = path.join(tempDir, "root-link");
    const filePath = path.join(symlinkRoot, "notes.txt");
    await fs.mkdir(targetRoot);
    await fs.writeFile(path.join(targetRoot, "notes.txt"), "hello");
    await fs.symlink(targetRoot, symlinkRoot);

    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "host.read_file",
          path: filePath,
          rootPath: symlinkRoot,
        },
        { runtimeManager: harness.manager },
      ),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("must not be a symlink"),
    });
  });

  it("enforces the 10 MB image read limit", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-large-image-");
    const imagePath = path.join(tempDir, "large.png");
    await fs.writeFile(imagePath, Buffer.alloc((10 * 1024 * 1024) + 1));

    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "host.read_file",
          path: imagePath,
          rootPath: tempDir,
        },
        { runtimeManager: harness.manager },
      ),
    ).rejects.toMatchObject({
      code: "file_too_large",
      message: expect.stringContaining("10 MB"),
    });
  });

  it("enforces the 25 MB non-image read limit", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-large-file-");
    const filePath = path.join(tempDir, "large.bin");
    await fs.writeFile(filePath, Buffer.alloc((25 * 1024 * 1024) + 1));

    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "host.read_file",
          path: filePath,
          rootPath: tempDir,
        },
        { runtimeManager: harness.manager },
      ),
    ).rejects.toMatchObject({
      code: "file_too_large",
      message: expect.stringContaining("25 MB"),
    });
  });

  it("treats svg files as utf8 text with the non-image size limit", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-svg-");
    const filePath = path.join(tempDir, "diagram.svg");
    const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>";
    await fs.writeFile(filePath, svg);

    const harness = createHarness();
    const result = await dispatchCommand(
      {
        type: "host.read_file",
        path: filePath,
        rootPath: tempDir,
      },
      { runtimeManager: harness.manager },
    );

    expect(result.mimeType).toBe("image/svg+xml");
    expect(result.contentEncoding).toBe("utf8");
    expect(result.content).toBe(svg);
  });

  it("falls back to base64 for declared text files whose bytes are not valid utf8", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-invalid-utf8-");
    const filePath = path.join(tempDir, "notes.txt");
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    await fs.writeFile(filePath, bytes);

    const harness = createHarness();
    const result = await dispatchCommand(
      {
        type: "host.read_file",
        path: filePath,
        rootPath: tempDir,
      },
      { runtimeManager: harness.manager },
    );

    expect(result.mimeType).toBe("text/plain");
    expect(result.contentEncoding).toBe("base64");
    expect(result.content).toBe(bytes.toString("base64"));
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
        workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
      },
      { runtimeManager: harness.manager },
    );

    expect(result.branches).toEqual(["main"]);
    expect(result.current).toBe("main");
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchCommand } from "../../src/command-dispatch.js";
import {
  cleanupTempDirs,
  createHarness,
  makeTempDir,
} from "./dispatch-helpers.js";

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
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "unmanaged",
        },
        mergeBaseBranch: "main",
      },
      harness.dispatchOptions(),
    );
    const diffResult = await dispatchCommand(
      {
        type: "workspace.diff",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "unmanaged",
        },
        target: { type: "all", mergeBaseBranch: "main" },
        maxDiffBytes: 2 * 1024 * 1024,
        maxFileListBytes: 256 * 1024,
      },
      harness.dispatchOptions(),
    );
    const commitResult = await dispatchCommand(
      {
        type: "workspace.commit",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "unmanaged",
        },
        message: "Commit message",
      },
      harness.dispatchOptions(),
    );
    const squashResult = await dispatchCommand(
      {
        type: "workspace.squash_merge",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "unmanaged",
        },
        targetBranch: "main",
        commitMessage: "feat: squash merge",
      },
      harness.dispatchOptions(),
    );
    expect(statusResult.workspaceStatus?.workingTree.state).toBe("clean");
    expect(diffResult.diff.diff).toBe("");
    expect(commitResult).toEqual({
      commitSha: "commit-1",
      commitSubject: "Commit message",
    });
    expect(squashResult).toEqual({
      merged: true,
      commitSha: "merge-main",
      commitSubject: "feat: squash merge",
    });
    expect(harness.workspaceState.statusReads).toBe(1);
    expect(harness.workspaceState.lastCommitMessage).toBe("Commit message");
  });

  it("rehydrates a missing workspace runtime from workspaceContext", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-rehydrate" });

    const result = await dispatchCommand(
      {
        type: "workspace.status",
        environmentId: "env-rehydrate",
        workspaceContext: {
          workspacePath: "/tmp/env-rehydrate",
          workspaceProvisionType: "unmanaged",
        },
      },
      harness.dispatchOptions(),
    );

    expect(result.workspaceStatus?.workingTree.state).toBe("clean");
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "unmanaged",
        path: "/tmp/env-rehydrate",
      },
    ]);
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
      harness.dispatchOptions(),
    );

    const paths = result.files.map((file) => file.path).sort();
    expect(paths).toEqual(["PREFERENCES.md", path.join("notes", "todo.md")]);
    expect(result.truncated).toBe(false);
  });

  it("returns empty files for host.list_files when path does not exist", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-list-missing-");
    const missingPath = path.join(tempDir, "does-not-exist");

    const harness = createHarness();
    const result = await dispatchCommand(
      {
        type: "host.list_files",
        path: missingPath,
        limit: 1000,
      },
      harness.dispatchOptions(),
    );

    expect(result.files).toEqual([]);
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
        harness.dispatchOptions(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("must not be a symlink"),
    });
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
      harness.dispatchOptions(),
    );

    expect(result.path).toBe(filePath);
    expect(result.content).toBe("durable manager notes");
    expect(result.contentEncoding).toBe("utf8");
    expect(result.sizeBytes).toBe("durable manager notes".length);
  });

  it("covers rootless host.read_file for explicit disk paths", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-file-rootless-");
    const filePath = path.join(tempDir, "notes.md");
    await fs.writeFile(filePath, "explicit host notes");

    const harness = createHarness();
    const result = await dispatchCommand(
      {
        type: "host.read_file",
        path: filePath,
      },
      harness.dispatchOptions(),
    );

    expect(result.path).toBe(filePath);
    expect(result.content).toBe("explicit host notes");
    expect(result.contentEncoding).toBe("utf8");
    expect(result.sizeBytes).toBe("explicit host notes".length);
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
      harness.dispatchOptions(),
    );

    expect(result.path).toBe(imagePath);
    expect(result.content).toBe(imageBytes.toString("base64"));
    expect(result.contentEncoding).toBe("base64");
    expect(result.mimeType).toBe("image/png");
    expect(result.sizeBytes).toBe(imageBytes.length);
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
        harness.dispatchOptions(),
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
        harness.dispatchOptions(),
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
      message: expect.stringContaining("Path does not exist"),
    });
  });

  it("normalizes missing rootless host.read_file paths to ENOENT", async () => {
    const tempDir = await makeTempDir(
      "bb-dispatch-host-read-rootless-missing-",
    );
    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "host.read_file",
          path: path.join(tempDir, "missing.md"),
        },
        harness.dispatchOptions(),
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
      message: expect.stringContaining("Path does not exist"),
    });
  });

  it("rejects rootless host.read_file directory paths", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-rootless-dir-");
    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "host.read_file",
          path: tempDir,
        },
        harness.dispatchOptions(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: "Path is a directory, not a file",
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
        harness.dispatchOptions(),
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
        harness.dispatchOptions(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("must not be a symlink"),
    });
  });

  it("enforces the 10 MB image read limit", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-large-image-");
    const imagePath = path.join(tempDir, "large.png");
    await fs.writeFile(imagePath, Buffer.alloc(10 * 1024 * 1024 + 1));

    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "host.read_file",
          path: imagePath,
          rootPath: tempDir,
        },
        harness.dispatchOptions(),
      ),
    ).rejects.toMatchObject({
      code: "file_too_large",
      message: expect.stringContaining("10 MB"),
    });
  });

  it("enforces the 25 MB non-image read limit", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-large-file-");
    const filePath = path.join(tempDir, "large.bin");
    await fs.writeFile(filePath, Buffer.alloc(25 * 1024 * 1024 + 1));

    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "host.read_file",
          path: filePath,
          rootPath: tempDir,
        },
        harness.dispatchOptions(),
      ),
    ).rejects.toMatchObject({
      code: "file_too_large",
      message: expect.stringContaining("25 MB"),
    });
  });

  it("treats svg files as utf8 text with the non-image size limit", async () => {
    const tempDir = await makeTempDir("bb-dispatch-host-read-svg-");
    const filePath = path.join(tempDir, "diagram.svg");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    await fs.writeFile(filePath, svg);

    const harness = createHarness();
    const result = await dispatchCommand(
      {
        type: "host.read_file",
        path: filePath,
        rootPath: tempDir,
      },
      harness.dispatchOptions(),
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
      harness.dispatchOptions(),
    );

    expect(result.mimeType).toBe("text/plain");
    expect(result.contentEncoding).toBe("base64");
    expect(result.content).toBe(bytes.toString("base64"));
  });
});

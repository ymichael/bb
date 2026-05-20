import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandDispatchError,
  type CommandOf,
  isExpectedCommandDispatchError,
} from "../command-dispatch-support.js";
import { readHostFile, readHostFileMetadata } from "./host-files.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runGit(
  args: readonly string[],
  options: { cwd: string },
): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd: options.cwd });
  return result.stdout;
}

async function initRepo(): Promise<string> {
  const repoPath = await makeTempDir("bb-host-files-test-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  return repoPath;
}

async function captureReadHostFileError(
  command: CommandOf<"host.read_file">,
): Promise<unknown> {
  try {
    await readHostFile(command);
  } catch (error) {
    return error;
  }

  throw new Error("Expected readHostFile to fail");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("readHostFile (no ref — disk read)", () => {
  it("reads explicit file contents from disk without a rootPath", async () => {
    const repoPath = await initRepo();
    const filePath = path.join(repoPath, "host-notes.md");
    await fs.writeFile(filePath, "host notes", "utf8");

    const result = await readHostFile({
      type: "host.read_file",
      path: filePath,
    });

    expect(result.path).toBe(filePath);
    expect(result.content).toBe("host notes");
    expect(result.contentEncoding).toBe("utf8");
    expect(result.sizeBytes).toBe(10);
  });

  it("reads file contents from disk", async () => {
    const repoPath = await initRepo();
    const filePath = path.join(repoPath, "hello.txt");
    await fs.writeFile(filePath, "hello world", "utf8");

    const result = await readHostFile({
      type: "host.read_file",
      path: filePath,
      rootPath: repoPath,
    });

    expect(result.content).toBe("hello world");
    expect(result.contentEncoding).toBe("utf8");
    expect(result.sizeBytes).toBe(11);
  });

  it("rejects relative paths", async () => {
    await expect(
      readHostFile({
        type: "host.read_file",
        path: "relative/file.txt",
        rootPath: "/tmp",
      }),
    ).rejects.toBeInstanceOf(CommandDispatchError);
  });

  it("marks missing targets under an existing root as expected", async () => {
    const repoPath = await initRepo();
    const missingPath = path.join(repoPath, "STATUS.md");
    const thrown = await captureReadHostFileError({
      type: "host.read_file",
      path: missingPath,
      rootPath: repoPath,
    });

    expect(thrown).toBeInstanceOf(CommandDispatchError);
    expect(thrown).toMatchObject({
      code: "ENOENT",
      message: `Path does not exist: ${missingPath}`,
      name: "ExpectedCommandDispatchError",
    });
    expect(isExpectedCommandDispatchError(thrown)).toBe(true);
  });

  it("marks missing rootless targets as expected", async () => {
    const repoPath = await initRepo();
    const missingPath = path.join(repoPath, "HOST-NOTES.md");
    const thrown = await captureReadHostFileError({
      type: "host.read_file",
      path: missingPath,
    });

    expect(thrown).toMatchObject({
      code: "ENOENT",
      message: `Path does not exist: ${missingPath}`,
      name: "ExpectedCommandDispatchError",
    });
    expect(isExpectedCommandDispatchError(thrown)).toBe(true);
  });

  it("does not mark missing roots as expected", async () => {
    const parentPath = await makeTempDir("bb-host-files-missing-root-");
    const rootPath = path.join(parentPath, "missing-root");
    const missingPath = path.join(rootPath, "STATUS.md");
    const thrown = await captureReadHostFileError({
      type: "host.read_file",
      path: missingPath,
      rootPath,
    });

    expect(thrown).toMatchObject({
      code: "ENOENT",
      message: `Path does not exist: ${missingPath}`,
      name: "CommandDispatchError",
    });
    expect(isExpectedCommandDispatchError(thrown)).toBe(false);
  });

  it("rejects rootless directory paths", async () => {
    const repoPath = await initRepo();

    await expect(
      readHostFile({
        type: "host.read_file",
        path: repoPath,
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: "Path is a directory, not a file",
    });
  });
});

describe("readHostFileMetadata", () => {
  it("returns host-side file metadata without reading contents", async () => {
    const repoPath = await initRepo();
    const filePath = path.join(repoPath, "large-preferences.md");
    await fs.writeFile(filePath, Buffer.alloc(25 * 1024 * 1024 + 1));

    const result = await readHostFileMetadata({
      type: "host.file_metadata",
      path: filePath,
      rootPath: repoPath,
    });

    expect(result.path).toBe(filePath);
    expect(result.sizeBytes).toBe(25 * 1024 * 1024 + 1);
    expect(result.modifiedAtMs).toBeGreaterThan(0);
  });

  it("uses the same containment checks as disk reads", async () => {
    const repoPath = await initRepo();
    const outsidePath = path.join(repoPath, "..", "outside-metadata.txt");
    const symlinkPath = path.join(repoPath, "outside-link");
    await fs.writeFile(outsidePath, "outside");
    await fs.symlink(outsidePath, symlinkPath);

    await expect(
      readHostFileMetadata({
        type: "host.file_metadata",
        path: symlinkPath,
        rootPath: repoPath,
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("escapes read root"),
    });
  });
});

describe("readHostFile (with ref — git history read)", () => {
  it("rejects ref reads without rootPath", async () => {
    const repoPath = await initRepo();

    await expect(
      readHostFile({
        type: "host.read_file",
        path: path.join(repoPath, "tracked.txt"),
        ref: "HEAD",
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: "rootPath is required when ref is set",
    });
  });

  it("reads file contents at a specific ref", async () => {
    const repoPath = await initRepo();
    const filePath = path.join(repoPath, "tracked.txt");
    await fs.writeFile(filePath, "version 1\n", "utf8");
    await runGit(["add", "tracked.txt"], { cwd: repoPath });
    await runGit(["commit", "-m", "v1"], { cwd: repoPath });

    // Mutate on disk so HEAD differs from the working tree.
    await fs.writeFile(filePath, "version 2\n", "utf8");

    const result = await readHostFile({
      type: "host.read_file",
      path: filePath,
      rootPath: repoPath,
      ref: "HEAD",
    });

    expect(result.content).toBe("version 1\n");
    expect(result.contentEncoding).toBe("utf8");
    expect(result.sizeBytes).toBe(10);
  });

  it("returns empty content when the file does not exist at the ref", async () => {
    const repoPath = await initRepo();
    // Create initial commit so HEAD exists.
    await fs.writeFile(path.join(repoPath, "seed.txt"), "seed\n", "utf8");
    await runGit(["add", "seed.txt"], { cwd: repoPath });
    await runGit(["commit", "-m", "seed"], { cwd: repoPath });

    const result = await readHostFile({
      type: "host.read_file",
      path: path.join(repoPath, "missing.txt"),
      rootPath: repoPath,
      ref: "HEAD",
    });

    expect(result.content).toBe("");
    expect(result.sizeBytes).toBe(0);
  });

  it("rejects unsafe refs (path traversal)", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, "f.txt"), "x", "utf8");
    await runGit(["add", "."], { cwd: repoPath });
    await runGit(["commit", "-m", "init"], { cwd: repoPath });

    await expect(
      readHostFile({
        type: "host.read_file",
        path: path.join(repoPath, "f.txt"),
        rootPath: repoPath,
        ref: "HEAD/../foo",
      }),
    ).rejects.toBeInstanceOf(CommandDispatchError);
  });

  it("rejects refs with leading dash", async () => {
    const repoPath = await initRepo();
    await expect(
      readHostFile({
        type: "host.read_file",
        path: path.join(repoPath, "f.txt"),
        rootPath: repoPath,
        ref: "-rf",
      }),
    ).rejects.toBeInstanceOf(CommandDispatchError);
  });

  it("rejects paths outside rootPath", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, "seed.txt"), "x", "utf8");
    await runGit(["add", "."], { cwd: repoPath });
    await runGit(["commit", "-m", "init"], { cwd: repoPath });

    await expect(
      readHostFile({
        type: "host.read_file",
        path: "/etc/passwd",
        rootPath: repoPath,
        ref: "HEAD",
      }),
    ).rejects.toBeInstanceOf(CommandDispatchError);
  });

  it("reads at a commit SHA other than HEAD", async () => {
    const repoPath = await initRepo();
    const filePath = path.join(repoPath, "tracked.txt");
    await fs.writeFile(filePath, "first\n", "utf8");
    await runGit(["add", "."], { cwd: repoPath });
    await runGit(["commit", "-m", "first"], { cwd: repoPath });
    const firstSha = (
      await runGit(["rev-parse", "HEAD"], { cwd: repoPath })
    ).trim();

    await fs.writeFile(filePath, "second\n", "utf8");
    await runGit(["commit", "-am", "second"], { cwd: repoPath });

    const result = await readHostFile({
      type: "host.read_file",
      path: filePath,
      rootPath: repoPath,
      ref: firstSha,
    });

    expect(result.content).toBe("first\n");
  });
});

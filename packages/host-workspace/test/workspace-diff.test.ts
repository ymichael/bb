import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace.js";
import { runGit } from "../src/git.js";
import type { RawDiffFileStat, WorkspaceDiffTarget } from "@bb/domain";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initRepo(): Promise<string> {
  const repoPath = await makeTempDir("bb-diff-repo-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await runGit(["config", "core.autocrlf", "false"], { cwd: repoPath });
  return repoPath;
}

async function write(
  repoPath: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const full = path.join(repoPath, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents, "utf8");
}

async function writeBytes(
  repoPath: string,
  relativePath: string,
  bytes: Buffer,
): Promise<void> {
  const full = path.join(repoPath, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, bytes);
}

async function commitAll(repoPath: string, message: string): Promise<void> {
  await runGit(["add", "-A"], { cwd: repoPath });
  await runGit(["commit", "-m", message], { cwd: repoPath });
}

async function removeFileAfterTemporaryPathspecWrite<T>(
  repoPath: string,
  relativePath: string,
  work: () => Promise<T>,
): Promise<T> {
  const originalWriteFile = fs.writeFile.bind(fs);
  let removed = false;
  const writeFile = vi
    .spyOn(fs, "writeFile")
    .mockImplementation(async (...args) => {
      const result = await originalWriteFile(...args);
      if (!removed && path.basename(String(args[0])) === "pathspec") {
        removed = true;
        await fs.rm(path.join(repoPath, relativePath));
      }
      return result;
    });
  try {
    return await work();
  } finally {
    writeFile.mockRestore();
  }
}

function findFile(
  files: RawDiffFileStat[],
  filePath: string,
): RawDiffFileStat | undefined {
  return files.find((file) => file.path === filePath);
}

const UNCOMMITTED: WorkspaceDiffTarget = { type: "uncommitted" };

async function fullDiffSectionFor(
  workspace: Workspace,
  target: WorkspaceDiffTarget,
  newPath: string,
): Promise<string> {
  const full = await workspace.getDiff({ target });
  const sections = splitFullDiff(full.diff);
  return sections.get(newPath) ?? "";
}

function splitFullDiff(combinedDiff: string): Map<string, string> {
  const byPath = new Map<string, string>();
  const lines = combinedDiff.split("\n");
  let currentPath: string | null = null;
  let currentLines: string[] = [];
  const flush = (): void => {
    if (currentPath !== null) {
      byPath.set(currentPath, formatDiffSection(currentLines));
    }
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const body = line.slice("diff --git ".length);
      const separator = body.lastIndexOf(" b/");
      currentPath = separator === -1 ? null : body.slice(separator + 3);
      currentLines = [line];
      continue;
    }
    if (currentPath !== null) {
      currentLines.push(line);
    }
  }
  flush();
  return byPath;
}

function formatDiffSection(lines: string[]): string {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end -= 1;
  }
  if (end === 0) {
    return "";
  }
  return `${lines.slice(0, end).join("\n")}\n`;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("Workspace.diffFiles", () => {
  it("reports staged and untracked files before the initial commit", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "staged.txt", "staged pending\n");
    await runGit(["add", "staged.txt"], { cwd: repoPath });
    await write(repoPath, "untracked.txt", "untracked pending\n");
    const workspace = new Workspace(repoPath);
    const statusBefore = await runGit(["status", "--porcelain=v1"], {
      cwd: repoPath,
    });

    const diff = await workspace.getDiff({ target: UNCOMMITTED });
    const files = await workspace.diffFiles({
      target: UNCOMMITTED,
      maxFiles: 5000,
    });
    const patches = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: ["staged.txt", "untracked.txt"],
      maxBytesPerFile: 64 * 1024,
    });

    expect(diff.files).toContain("staged.txt");
    expect(diff.files).toContain("untracked.txt");
    expect(diff.shortstat).toContain("2 files changed");
    expect(files.files).toEqual([
      expect.objectContaining({
        path: "staged.txt",
        additions: 1,
        origin: "tracked",
        statusLetter: "A",
      }),
      expect.objectContaining({
        path: "untracked.txt",
        additions: 1,
        origin: "untracked",
        statusLetter: "A",
      }),
    ]);
    expect(patches).toEqual([
      expect.objectContaining({
        path: "staged.txt",
        patch: expect.stringContaining("staged pending"),
      }),
      expect.objectContaining({
        path: "untracked.txt",
        patch: expect.stringContaining("untracked pending"),
      }),
    ]);
    const statusAfter = await runGit(["status", "--porcelain=v1"], {
      cwd: repoPath,
    });
    expect(statusAfter.stdout).toBe(statusBefore.stdout);
  });

  it("reports additions, modifications, and deletions with numstat counts", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "keep.txt", "a\nb\nc\n");
    await write(repoPath, "remove.txt", "x\ny\n");
    await commitAll(repoPath, "base");

    await write(repoPath, "keep.txt", "a\nB\nc\nd\n");
    await write(repoPath, "added.txt", "new\nfile\n");
    await fs.rm(path.join(repoPath, "remove.txt"));
    await runGit(["add", "added.txt"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const result = await workspace.diffFiles({
      target: UNCOMMITTED,
      maxFiles: 5000,
    });

    const added = findFile(result.files, "added.txt");
    expect(added).toEqual({
      path: "added.txt",
      previousPath: null,
      statusLetter: "A",
      additions: 2,
      deletions: 0,
      binary: false,
      origin: "tracked",
    });

    const modified = findFile(result.files, "keep.txt");
    expect(modified?.statusLetter).toBe("M");
    expect(modified?.additions).toBe(2);
    expect(modified?.deletions).toBe(1);

    const deleted = findFile(result.files, "remove.txt");
    expect(deleted?.statusLetter).toBe("D");
    expect(deleted?.additions).toBe(0);
    expect(deleted?.deletions).toBe(2);

    expect(result.shortstat).toContain("changed");
    expect(result.mergeBaseRef).toBeNull();
  });

  it("detects renames with previousPath and copies", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "original.txt", "line1\nline2\nline3\nline4\n");
    await commitAll(repoPath, "base");

    await runGit(["mv", "original.txt", "renamed.txt"], { cwd: repoPath });
    await commitAll(repoPath, "rename");

    const workspace = new Workspace(repoPath);
    const result = await workspace.diffFiles({
      target: { type: "commit", sha: "HEAD" },
      maxFiles: 5000,
    });

    const renamed = findFile(result.files, "renamed.txt");
    expect(renamed?.statusLetter).toBe("R");
    expect(renamed?.previousPath).toBe("original.txt");
  });

  it("detects a type change (file to symlink) as statusLetter T", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "target.txt", "hello\n");
    await write(repoPath, "thing", "i am a regular file\n");
    await commitAll(repoPath, "base");

    await fs.rm(path.join(repoPath, "thing"));
    await fs.symlink("target.txt", path.join(repoPath, "thing"));

    const workspace = new Workspace(repoPath);
    const result = await workspace.diffFiles({
      target: UNCOMMITTED,
      maxFiles: 5000,
    });

    const typeChanged = findFile(result.files, "thing");
    expect(typeChanged?.statusLetter).toBe("T");
  });

  it("marks binary files with binary:true and zero counts", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "readme.txt", "text\n");
    await commitAll(repoPath, "base");

    await writeBytes(
      repoPath,
      "image.bin",
      Buffer.from([0, 1, 2, 0, 255, 254, 0, 10, 0]),
    );

    const workspace = new Workspace(repoPath);
    const result = await workspace.diffFiles({
      target: UNCOMMITTED,
      maxFiles: 5000,
    });

    const binary = findFile(result.files, "image.bin");
    expect(binary?.binary).toBe(true);
    expect(binary?.additions).toBe(0);
    expect(binary?.deletions).toBe(0);
    expect(binary?.origin).toBe("untracked");
  });

  it("includes untracked files tagged origin:untracked for uncommitted target", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "tracked.txt", "one\n");
    await commitAll(repoPath, "base");

    await write(repoPath, "tracked.txt", "one\ntwo\n");
    await write(repoPath, "untracked.txt", "fresh\ncontent\n");

    const workspace = new Workspace(repoPath);
    const result = await workspace.diffFiles({
      target: UNCOMMITTED,
      maxFiles: 5000,
    });

    const tracked = findFile(result.files, "tracked.txt");
    expect(tracked?.origin).toBe("tracked");

    const untracked = findFile(result.files, "untracked.txt");
    expect(untracked).toEqual({
      path: "untracked.txt",
      previousPath: null,
      statusLetter: "A",
      additions: 2,
      deletions: 0,
      binary: false,
      origin: "untracked",
    });
  });

  it("supports untracked files outside a sparse-checkout cone", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "inside/base.txt", "base\n");
    await commitAll(repoPath, "base");
    await runGit(["sparse-checkout", "init", "--cone"], { cwd: repoPath });
    await runGit(["sparse-checkout", "set", "inside"], { cwd: repoPath });
    await write(repoPath, "outside/new.txt", "outside\ncone\n");
    const workspace = new Workspace(repoPath);
    const statusBefore = await runGit(["status", "--porcelain=v1"], {
      cwd: repoPath,
    });

    const [diff, files, patches] = await Promise.all([
      workspace.getDiff({
        target: UNCOMMITTED,
        maxUntrackedFiles: 500,
      }),
      workspace.diffFiles({ target: UNCOMMITTED, maxFiles: 500 }),
      workspace.diffPatch({
        target: UNCOMMITTED,
        paths: ["outside/new.txt"],
        maxBytesPerFile: 64 * 1024,
      }),
    ]);

    expect(diff.diff).toContain("+outside");
    expect(findFile(files.files, "outside/new.txt")).toEqual(
      expect.objectContaining({ additions: 2, origin: "untracked" }),
    );
    expect(patches[0]?.patch).toContain("+outside");
    const statusAfter = await runGit(["status", "--porcelain=v1"], {
      cwd: repoPath,
    });
    expect(statusAfter.stdout).toBe(statusBefore.stdout);
  });

  it("returns placeholders instead of rejecting when an untracked file disappears during indexing", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "base.txt", "base\n");
    await commitAll(repoPath, "base");
    await write(repoPath, "gone.txt", "gone\n");
    await write(repoPath, "keep.txt", "keep\nstill here\n");

    const result = await removeFileAfterTemporaryPathspecWrite(
      repoPath,
      "gone.txt",
      () =>
        new Workspace(repoPath).diffFiles({
          target: UNCOMMITTED,
          maxFiles: 500,
        }),
    );

    expect(findFile(result.files, "keep.txt")).toEqual(
      expect.objectContaining({ additions: 2, origin: "untracked" }),
    );
    expect(findFile(result.files, "gone.txt")).toEqual(
      expect.objectContaining({
        additions: 0,
        deletions: 0,
        origin: "untracked",
      }),
    );
  });

  it("returns an exact truncated untracked slice at the file cap", async () => {
    const repoPath = await initRepo();
    await Promise.all([
      write(repoPath, "one.txt", "one\n"),
      write(repoPath, "two.txt", "two\n"),
      write(repoPath, "three.txt", "three\n"),
    ]);

    const result = await new Workspace(repoPath).diffFiles({
      target: UNCOMMITTED,
      maxFiles: 2,
    });

    expect(result.files).toHaveLength(2);
    expect(result.files.every((file) => file.origin === "untracked")).toBe(
      true,
    );
    expect(result.files.every((file) => file.additions === 1)).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.shortstat).toContain("2 files changed");
  });

  it("returns an exact truncated tracked slice after bounded enumeration", async () => {
    const repoPath = await initRepo();
    for (let index = 0; index < 5; index += 1) {
      await write(repoPath, `tracked-${index}.txt`, `base ${index}\n`);
    }
    await commitAll(repoPath, "base");
    for (let index = 0; index < 5; index += 1) {
      await write(repoPath, `tracked-${index}.txt`, `changed ${index}\n`);
    }

    const result = await new Workspace(repoPath).diffFiles({
      target: UNCOMMITTED,
      maxFiles: 2,
    });

    expect(result.files).toHaveLength(2);
    expect(result.files.every((file) => file.origin === "tracked")).toBe(true);
    expect(result.files).toEqual([
      expect.objectContaining({ additions: 1, deletions: 1 }),
      expect.objectContaining({ additions: 1, deletions: 1 }),
    ]);
    expect(result.truncated).toBe(true);
    expect(result.shortstat).toContain("2 files changed");
  });

  it("keeps rename stats exact in a truncated tracked slice", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "a-before.txt", "one\ntwo\nthree\nfour\nfive\n");
    await write(repoPath, "b.txt", "before\n");
    await write(repoPath, "c.txt", "before\n");
    await commitAll(repoPath, "base");

    await runGit(["mv", "a-before.txt", "a-after.txt"], { cwd: repoPath });
    await write(repoPath, "a-after.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
    await write(repoPath, "b.txt", "after\n");
    await write(repoPath, "c.txt", "after\n");

    const result = await new Workspace(repoPath).diffFiles({
      target: UNCOMMITTED,
      maxFiles: 2,
    });

    expect(result.truncated).toBe(true);
    expect(result.files).toContainEqual(
      expect.objectContaining({
        path: "a-after.txt",
        previousPath: "a-before.txt",
        statusLetter: "R",
        additions: 1,
        deletions: 0,
      }),
    );
  });

  it("keeps full-diff add/delete classification when a truncated slice is below the rename limit", async () => {
    const repoPath = await initRepo();
    await runGit(["config", "diff.renameLimit", "15"], { cwd: repoPath });
    const originalContents = Array.from({ length: 20 }, (_unused, index) =>
      [`identity ${index}`, ...Array.from({ length: 40 }, () => "shared")]
        .join("\n")
        .concat("\n"),
    );
    for (let index = 0; index < originalContents.length; index += 1) {
      const pair = String(index).padStart(2, "0");
      await write(
        repoPath,
        `pair-${pair}-a.txt`,
        originalContents[index] ?? "",
      );
    }
    await commitAll(repoPath, "base");

    for (let index = 0; index < originalContents.length; index += 1) {
      const pair = String(index).padStart(2, "0");
      await write(
        repoPath,
        `pair-${pair}-b.txt`,
        `${originalContents[index] ?? ""}changed ${index}\n`,
      );
      await fs.rm(path.join(repoPath, `pair-${pair}-a.txt`));
    }
    await runGit(["add", "-A"], { cwd: repoPath });

    const result = await new Workspace(repoPath).diffFiles({
      target: UNCOMMITTED,
      maxFiles: 10,
    });

    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(10);
    for (const file of result.files) {
      if (file.statusLetter === "D") {
        expect(file).toMatchObject({ additions: 0, deletions: 41 });
      } else {
        expect(file).toMatchObject({
          statusLetter: "A",
          additions: 42,
          deletions: 0,
        });
      }
    }
    expect(result.shortstat).toContain("10 files changed");
    expect(result.shortstat).toContain("210 insertions(+)");
    expect(result.shortstat).toContain("205 deletions(-)");
  });

  it("does not include untracked files for a commit target", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "a.txt", "a\n");
    await commitAll(repoPath, "base");
    await write(repoPath, "b.txt", "b\n");
    await commitAll(repoPath, "second");
    await write(repoPath, "untracked.txt", "loose\n");

    const workspace = new Workspace(repoPath);
    const result = await workspace.diffFiles({
      target: { type: "commit", sha: "HEAD" },
      maxFiles: 5000,
    });

    expect(findFile(result.files, "b.txt")).toBeDefined();
    expect(findFile(result.files, "untracked.txt")).toBeUndefined();
  });
});

describe("Workspace.diffPatch", () => {
  const BIG_BUDGET = 10_000_000;

  it("returns a tracked file patch matching the full-diff slice byte-for-byte", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "alpha.txt", "1\n2\n3\n");
    await write(repoPath, "beta.txt", "x\ny\n");
    await commitAll(repoPath, "base");

    await write(repoPath, "alpha.txt", "1\nTWO\n3\n4\n");
    await write(repoPath, "beta.txt", "x\nY\n");

    const workspace = new Workspace(repoPath);
    const expected = await fullDiffSectionFor(
      workspace,
      UNCOMMITTED,
      "alpha.txt",
    );
    const patches = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: ["alpha.txt"],
      maxBytesPerFile: BIG_BUDGET,
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.path).toBe("alpha.txt");
    expect(patches[0]?.truncated).toBe(false);
    expect(patches[0]?.patch).toBe(expected);
    expect(patches[0]?.patch).not.toContain("beta.txt");
  });

  it("returns a tracked binary patch byte-equal to git diff --binary in a multi-file page", async () => {
    const repoPath = await initRepo();
    await writeBytes(
      repoPath,
      "logo.png",
      Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );
    await write(repoPath, "alpha.txt", "1\n2\n3\n");
    await commitAll(repoPath, "base");

    await writeBytes(
      repoPath,
      "logo.png",
      Buffer.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12, 13]),
    );
    await write(repoPath, "alpha.txt", "1\nTWO\n3\n");

    const workspace = new Workspace(repoPath);
    const perFileBinary = await runGit(
      ["diff", "--no-ext-diff", "--binary", "-M", "HEAD", "--", "logo.png"],
      { cwd: repoPath },
    );
    const patches = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: ["logo.png", "alpha.txt"],
      maxBytesPerFile: BIG_BUDGET,
    });

    const binary = patches.find((patch) => patch.path === "logo.png");
    expect(binary?.patch).toContain("GIT binary patch");
    expect(binary?.patch).toBe(perFileBinary.stdout);
    expect(binary?.patch.endsWith("\n\n")).toBe(true);
    expect(binary?.patch).not.toContain("alpha.txt");
  });

  it("preserves rename detection in a path-subset patch", async () => {
    const repoPath = await initRepo();
    await write(
      repoPath,
      "original.txt",
      "alpha\nbeta\ngamma\ndelta\nepsilon\n",
    );
    await commitAll(repoPath, "base");

    await runGit(["mv", "original.txt", "renamed.txt"], { cwd: repoPath });
    await write(
      repoPath,
      "renamed.txt",
      "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n",
    );
    await commitAll(repoPath, "rename with edit");

    const target: WorkspaceDiffTarget = { type: "commit", sha: "HEAD" };
    const workspace = new Workspace(repoPath);

    const expected = await fullDiffSectionFor(workspace, target, "renamed.txt");
    const patches = await workspace.diffPatch({
      target,
      paths: ["renamed.txt"],
      maxBytesPerFile: BIG_BUDGET,
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.patch).toBe(expected);
    expect(patches[0]?.patch).toMatch(/rename from original\.txt/);
    expect(patches[0]?.patch).toMatch(/rename to renamed\.txt/);
  });

  it("renders untracked files via the alternate-index path", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "tracked.txt", "base\n");
    await commitAll(repoPath, "base");
    const untrackedPath = "odd [name] file.txt";
    await write(repoPath, untrackedPath, "new\nfile\nhere\n");

    const workspace = new Workspace(repoPath);
    const patches = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: [untrackedPath],
      maxBytesPerFile: BIG_BUDGET,
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.path).toBe(untrackedPath);
    expect(patches[0]?.patch).toContain("+new");
    expect(patches[0]?.patch).toContain("+file");
    expect(patches[0]?.patch).toContain("+here");
    expect(patches[0]?.patch.length).toBeGreaterThan(0);
  });

  it("keeps surviving patches when another untracked file disappears during indexing", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "base.txt", "base\n");
    await commitAll(repoPath, "base");
    await write(repoPath, "gone.txt", "gone\n");
    await write(repoPath, "keep.txt", "keep\n");

    const patches = await removeFileAfterTemporaryPathspecWrite(
      repoPath,
      "gone.txt",
      () =>
        new Workspace(repoPath).diffPatch({
          target: UNCOMMITTED,
          paths: ["gone.txt", "keep.txt"],
          maxBytesPerFile: BIG_BUDGET,
        }),
    );

    expect(patches.map((entry) => entry.path)).toEqual([
      "gone.txt",
      "keep.txt",
    ]);
    expect(patches[0]?.patch).toBe("");
    expect(patches[1]?.patch).toContain("+keep");
  });

  it("matches the full-diff slice for an untracked file", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "tracked.txt", "base\n");
    await commitAll(repoPath, "base");
    await write(repoPath, "untracked.txt", "alpha\nbeta\n");

    const workspace = new Workspace(repoPath);
    const expected = await fullDiffSectionFor(
      workspace,
      UNCOMMITTED,
      "untracked.txt",
    );
    const patches = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: ["untracked.txt"],
      maxBytesPerFile: BIG_BUDGET,
    });

    expect(patches[0]?.patch).toBe(expected);
  });

  it("returns patches for a mixed tracked + untracked subset", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "tracked.txt", "1\n2\n");
    await commitAll(repoPath, "base");
    await write(repoPath, "tracked.txt", "1\n2\n3\n");
    await write(repoPath, "untracked.txt", "loose\n");

    const workspace = new Workspace(repoPath);
    const patches = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: ["untracked.txt", "tracked.txt"],
      maxBytesPerFile: BIG_BUDGET,
    });

    expect(patches.map((entry) => entry.path)).toEqual([
      "untracked.txt",
      "tracked.txt",
    ]);
    expect(patches[0]?.patch).toContain("+loose");
    expect(patches[1]?.patch).toContain("+3");
  });

  it("truncates a patch exceeding maxBytesPerFile and sets truncated", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "base.txt", "seed\n");
    await commitAll(repoPath, "base");

    const longBody = Array.from(
      { length: 200 },
      (_unused, index) => `line ${index}`,
    ).join("\n");
    await write(repoPath, "big.txt", `${longBody}\n`);

    const workspace = new Workspace(repoPath);
    const [entry] = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: ["big.txt"],
      maxBytesPerFile: 100,
    });

    expect(entry?.truncated).toBe(true);
    expect(Buffer.byteLength(entry?.patch ?? "", "utf8")).toBeLessThanOrEqual(
      100,
    );
  });

  it("bounds a single tracked file whose raw patch exceeds the per-file budget without throwing", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "huge.txt", "seed\n");
    await commitAll(repoPath, "base");

    const longLine = "x".repeat(400 * 1024);
    await write(repoPath, "huge.txt", `${longLine}\n`);

    const workspace = new Workspace(repoPath);
    const budget = 16 * 1024;
    const patches = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: ["huge.txt"],
      maxBytesPerFile: budget,
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.path).toBe("huge.txt");
    expect(patches[0]?.truncated).toBe(true);
    expect(patches[0]?.patch.length).toBeGreaterThan(0);
    expect(
      Buffer.byteLength(patches[0]?.patch ?? "", "utf8"),
    ).toBeLessThanOrEqual(budget);
  });

  it("bounds every entry of a page whose raw combined diff exceeds the 16 MB default buffer", async () => {
    const repoPath = await initRepo();
    const fileCount = 6;
    for (let index = 0; index < fileCount; index += 1) {
      await write(repoPath, `big-${index}.txt`, "seed\n");
    }
    await commitAll(repoPath, "base");

    const longLine = "z".repeat(5 * 1024 * 1024);
    const paths: string[] = [];
    for (let index = 0; index < fileCount; index += 1) {
      const relativePath = `big-${index}.txt`;
      await write(repoPath, relativePath, `${longLine}-${index}\n`);
      paths.push(relativePath);
    }

    const workspace = new Workspace(repoPath);
    const budget = 64 * 1024;
    const patches = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths,
      maxBytesPerFile: budget,
    });

    expect(patches.map((entry) => entry.path)).toEqual(paths);
    for (const entry of patches) {
      expect(entry.truncated).toBe(true);
      expect(entry.patch.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(entry.patch, "utf8")).toBeLessThanOrEqual(
        budget,
      );
    }
  });

  it("matches the full-diff slice for a branch_committed rename target", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "mod.txt", "stable\n");
    await write(repoPath, "before.txt", "one\ntwo\nthree\nfour\n");
    await commitAll(repoPath, "base");
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await runGit(["mv", "before.txt", "after.txt"], { cwd: repoPath });
    await write(repoPath, "mod.txt", "stable\nmore\n");
    await commitAll(repoPath, "feature work");

    const target: WorkspaceDiffTarget = {
      type: "branch_committed",
      mergeBaseBranch: "main",
    };
    const workspace = new Workspace(repoPath);

    const expectedRename = await fullDiffSectionFor(
      workspace,
      target,
      "after.txt",
    );
    const expectedMod = await fullDiffSectionFor(workspace, target, "mod.txt");

    const patches = await workspace.diffPatch({
      target,
      paths: ["after.txt", "mod.txt"],
      maxBytesPerFile: BIG_BUDGET,
    });

    expect(patches.find((p) => p.path === "after.txt")?.patch).toBe(
      expectedRename,
    );
    expect(patches.find((p) => p.path === "mod.txt")?.patch).toBe(expectedMod);
  });

  it("ignores requested paths that are not in the target's changes", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "real.txt", "a\n");
    await commitAll(repoPath, "base");
    await write(repoPath, "real.txt", "a\nb\n");

    const workspace = new Workspace(repoPath);
    const patches = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: ["real.txt", "does-not-exist.txt"],
      maxBytesPerFile: 10_000_000,
    });

    expect(patches.map((p) => p.path)).toEqual([
      "real.txt",
      "does-not-exist.txt",
    ]);
    expect(patches.find((p) => p.path === "real.txt")?.patch).toContain("+b");
    expect(patches.find((p) => p.path === "does-not-exist.txt")?.patch).toBe(
      "",
    );
  });

  it("returns a non-empty patch for a tracked path containing a space", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "my file.txt", "alpha\nbeta\ngamma\n");
    await write(repoPath, "other.txt", "untouched\n");
    await commitAll(repoPath, "base");

    await write(repoPath, "my file.txt", "alpha\nBETA\ngamma\ndelta\n");

    const workspace = new Workspace(repoPath);
    const expected = await fullDiffSectionFor(
      workspace,
      UNCOMMITTED,
      "my file.txt",
    );
    const patches = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: ["my file.txt"],
      maxBytesPerFile: BIG_BUDGET,
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.path).toBe("my file.txt");
    expect(patches[0]?.patch.length).toBeGreaterThan(0);
    expect(patches[0]?.patch).toBe(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it("preserves rename framing when a renamed side's path contains a space", async () => {
    const repoPath = await initRepo();
    await write(
      repoPath,
      "old name.txt",
      "alpha\nbeta\ngamma\ndelta\nepsilon\n",
    );
    await commitAll(repoPath, "base");

    await runGit(["mv", "old name.txt", "new name.txt"], { cwd: repoPath });
    await write(
      repoPath,
      "new name.txt",
      "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n",
    );
    await commitAll(repoPath, "rename with edit");

    const target: WorkspaceDiffTarget = { type: "commit", sha: "HEAD" };
    const workspace = new Workspace(repoPath);

    const expected = await fullDiffSectionFor(
      workspace,
      target,
      "new name.txt",
    );
    const patches = await workspace.diffPatch({
      target,
      paths: ["new name.txt"],
      maxBytesPerFile: BIG_BUDGET,
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.path).toBe("new name.txt");
    expect(patches[0]?.patch).toBe(expected);
    expect(expected.length).toBeGreaterThan(0);
    expect(patches[0]?.patch).toMatch(/rename from /);
    expect(patches[0]?.patch).toMatch(/rename to /);
  });

  it("splits a multi-file page including a space-in-path file from one combined diff", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "my file.txt", "alpha\nbeta\ngamma\n");
    await write(repoPath, "normal.txt", "one\ntwo\nthree\n");
    await write(repoPath, "untouched.txt", "stable\n");
    await commitAll(repoPath, "base");

    await write(repoPath, "my file.txt", "alpha\nBETA\ngamma\ndelta\n");
    await write(repoPath, "normal.txt", "one\nTWO\nthree\nfour\n");

    const workspace = new Workspace(repoPath);
    const expectedSpace = await fullDiffSectionFor(
      workspace,
      UNCOMMITTED,
      "my file.txt",
    );
    const expectedNormal = await fullDiffSectionFor(
      workspace,
      UNCOMMITTED,
      "normal.txt",
    );

    const patches = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: ["my file.txt", "normal.txt"],
      maxBytesPerFile: BIG_BUDGET,
    });

    expect(patches.map((entry) => entry.path)).toEqual([
      "my file.txt",
      "normal.txt",
    ]);
    expect(patches.find((p) => p.path === "my file.txt")?.patch).toBe(
      expectedSpace,
    );
    expect(patches.find((p) => p.path === "normal.txt")?.patch).toBe(
      expectedNormal,
    );
    expect(expectedSpace.length).toBeGreaterThan(0);
    expect(expectedNormal.length).toBeGreaterThan(0);
    expect(patches.find((p) => p.path === "my file.txt")?.patch).not.toContain(
      "normal.txt",
    );
    expect(patches.find((p) => p.path === "normal.txt")?.patch).not.toContain(
      "my file.txt",
    );
  });

  it("splits a multi-file page containing a rename alongside a plain edit", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "before.txt", "alpha\nbeta\ngamma\ndelta\nepsilon\n");
    await write(repoPath, "edit.txt", "keep\n");
    await commitAll(repoPath, "base");

    await runGit(["mv", "before.txt", "after.txt"], { cwd: repoPath });
    await write(
      repoPath,
      "after.txt",
      "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n",
    );
    await write(repoPath, "edit.txt", "keep\nmore\n");
    await commitAll(repoPath, "rename with edit plus a plain edit");

    const target: WorkspaceDiffTarget = { type: "commit", sha: "HEAD" };
    const workspace = new Workspace(repoPath);

    const expectedRename = await fullDiffSectionFor(
      workspace,
      target,
      "after.txt",
    );
    const expectedEdit = await fullDiffSectionFor(
      workspace,
      target,
      "edit.txt",
    );

    const patches = await workspace.diffPatch({
      target,
      paths: ["after.txt", "edit.txt"],
      maxBytesPerFile: BIG_BUDGET,
    });

    expect(patches.find((p) => p.path === "after.txt")?.patch).toBe(
      expectedRename,
    );
    expect(patches.find((p) => p.path === "edit.txt")?.patch).toBe(
      expectedEdit,
    );
    expect(patches.find((p) => p.path === "after.txt")?.patch).toMatch(
      /rename from before\.txt/,
    );
    expect(patches.find((p) => p.path === "after.txt")?.patch).toMatch(
      /rename to after\.txt/,
    );
  });

  it("returns a non-empty patch for a path with non-ASCII characters", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "café.txt", "un\ndeux\ntrois\n");
    await write(repoPath, "plain.txt", "stable\n");
    await commitAll(repoPath, "base");

    await write(repoPath, "café.txt", "un\nDEUX\ntrois\nquatre\n");

    const workspace = new Workspace(repoPath);
    const patches = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: ["café.txt"],
      maxBytesPerFile: BIG_BUDGET,
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.path).toBe("café.txt");
    expect(patches[0]?.patch.length).toBeGreaterThan(0);
    expect(patches[0]?.patch).toContain("+DEUX");
    expect(patches[0]?.patch).toContain("+quatre");
    expect(patches[0]?.patch).not.toContain("plain.txt");
  });

  it("truncates on a UTF-8 boundary without emitting U+FFFD or overshooting", async () => {
    const repoPath = await initRepo();
    await write(repoPath, "seed.txt", "seed\n");
    await commitAll(repoPath, "base");

    const multibyteBody = `${"中".repeat(200)}\n`;
    await write(repoPath, "multibyte.txt", multibyteBody);

    const workspace = new Workspace(repoPath);
    const [full] = await workspace.diffPatch({
      target: UNCOMMITTED,
      paths: ["multibyte.txt"],
      maxBytesPerFile: BIG_BUDGET,
    });
    const fullPatch = full?.patch ?? "";
    const fullBytes = Buffer.from(fullPatch, "utf8");
    const leadOffset = fullBytes.indexOf(0xe4);
    expect(leadOffset).toBeGreaterThan(0);

    for (const maxBytes of [leadOffset, leadOffset + 1, leadOffset + 2]) {
      const [entry] = await workspace.diffPatch({
        target: UNCOMMITTED,
        paths: ["multibyte.txt"],
        maxBytesPerFile: maxBytes,
      });

      expect(entry?.truncated).toBe(true);
      expect(entry?.patch).not.toContain("�");
      expect(Buffer.byteLength(entry?.patch ?? "", "utf8")).toBeLessThanOrEqual(
        maxBytes,
      );
      expect(
        fullBytes
          .subarray(0, Buffer.byteLength(entry?.patch ?? "", "utf8"))
          .toString("utf8"),
      ).toBe(entry?.patch);
    }
  });
});

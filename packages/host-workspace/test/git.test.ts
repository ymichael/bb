import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectGitRepo,
  detectGitRepoKind,
  getCheckoutRef,
  getWorkspaceGitOperation,
  parseNameStatusEntries,
  parseNumstatEntriesZ,
  parsePorcelainEntries,
  readDefaultBranchRefs,
  readGitBlob,
  readGitRepositoryState,
  runGit,
  runGitWithNullRecordLimit,
  runShellPipeline,
  summarizeNumstat,
} from "../src/git.js";

const tempDirs: string[] = [];

async function initReadGitBlobRepo() {
  const repoPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "bb-read-git-blob-"),
  );
  tempDirs.push(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.mkdir(path.join(repoPath, "docs"));
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await fs.writeFile(path.join(repoPath, "docs", "index.md"), "docs\n", "utf8");
  await fs.writeFile(path.join(repoPath, "large.txt"), "0123456789\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  return repoPath;
}

async function initEmptyRepo() {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "bb-empty-git-"));
  tempDirs.push(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  return repoPath;
}

async function initConflictRepo() {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "bb-git-conflict-"));
  tempDirs.push(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  await runGit(["switch", "-c", "feature"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
  await runGit(["commit", "-am", "Feature edit"], { cwd: repoPath });
  await runGit(["switch", "main"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "main\n", "utf8");
  await runGit(["commit", "-am", "Main edit"], { cwd: repoPath });
  return repoPath;
}

async function initDefaultBranchRemoteRepo() {
  const repoPath = await initReadGitBlobRepo();
  const remotePath = await fs.mkdtemp(path.join(os.tmpdir(), "bb-git-remote-"));
  tempDirs.push(remotePath);
  await runGit(["init", "--bare"], { cwd: remotePath });
  await runGit(["remote", "add", "origin", remotePath], { cwd: repoPath });
  await runGit(["push", "-u", "origin", "main"], { cwd: repoPath });
  await runGit(["fetch", "origin"], { cwd: repoPath });
  return { remotePath, repoPath };
}

async function pushRemoteMainCommit(remotePath: string) {
  const cloneParent = await fs.mkdtemp(
    path.join(os.tmpdir(), "bb-git-remote-clone-"),
  );
  tempDirs.push(cloneParent);
  const clonePath = path.join(cloneParent, "repo");
  await runGit(["clone", "--branch", "main", remotePath, clonePath], {
    cwd: cloneParent,
  });
  await runGit(["config", "user.name", "BB Tests"], { cwd: clonePath });
  await runGit(["config", "user.email", "bb@example.com"], {
    cwd: clonePath,
  });
  await fs.writeFile(path.join(clonePath, "remote.txt"), "remote\n", "utf8");
  await runGit(["add", "."], { cwd: clonePath });
  await runGit(["commit", "-m", "Remote edit"], { cwd: clonePath });
  await runGit(["push", "origin", "main"], { cwd: clonePath });
}

async function initBareWorktreeLayout() {
  const origin = await initReadGitBlobRepo();
  await runGit(["branch", "feature-a"], { cwd: origin });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-bare-layout-"));
  tempDirs.push(root);
  await runGit(["clone", "--bare", origin, ".bare"], { cwd: root });
  await fs.writeFile(path.join(root, ".git"), "gitdir: ./.bare\n", "utf8");
  await runGit(["worktree", "add", "feature-a", "feature-a"], { cwd: root });
  return { root, worktreePath: path.join(root, "feature-a") };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("runShellPipeline", () => {
  it("scrubs inherited bb runtime env vars and node mode", async () => {
    const repoPath = await initEmptyRepo();
    vi.stubEnv("BB_DATA_DIR", "/tmp/leaked-bb-data");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "external-secret");

    const result = await runShellPipeline(
      `printf '%s|%s|%s' "\${BB_DATA_DIR-missing}" "\${NODE_ENV-missing}" "\${OPENAI_API_KEY-missing}"`,
      [],
      { cwd: repoPath },
    );

    expect(result.stdout).toBe("missing|missing|external-secret");
  });
});

describe("runGitWithNullRecordLimit", () => {
  it("stops an untracked path listing at the requested complete-record count", async () => {
    const repoPath = await initEmptyRepo();
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        fs.writeFile(path.join(repoPath, `file-${index}.txt`), `${index}\n`),
      ),
    );

    const result = await runGitWithNullRecordLimit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: repoPath },
      "single",
      3,
    );

    expect(result.recordLimitReached).toBe(true);
    expect(result.recordCount).toBe(3);
    expect(result.stdout.split("\0").filter(Boolean)).toHaveLength(3);
  });

  it("keeps rename records complete when stopping name-status output", async () => {
    const repoPath = await initReadGitBlobRepo();
    await runGit(["mv", "README.md", "RENAMED.md"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "docs", "index.md"), "changed\n");
    await fs.rm(path.join(repoPath, "large.txt"));

    const result = await runGitWithNullRecordLimit(
      ["diff", "--name-status", "-M", "-z", "HEAD"],
      { cwd: repoPath },
      "name-status",
      2,
    );

    expect(result.recordLimitReached).toBe(true);
    expect(result.recordCount).toBe(2);
    expect(parseNameStatusEntries(result.stdout)).toHaveLength(2);
  });

  it("keeps rename records complete when stopping numstat output", async () => {
    const repoPath = await initReadGitBlobRepo();
    await runGit(["mv", "README.md", "RENAMED.md"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "RENAMED.md"), "hello\nmore\n");
    await fs.writeFile(path.join(repoPath, "docs", "index.md"), "changed\n");
    await fs.rm(path.join(repoPath, "large.txt"));

    const result = await runGitWithNullRecordLimit(
      ["diff", "--numstat", "-M", "-z", "HEAD"],
      { cwd: repoPath },
      "numstat",
      2,
    );

    expect(result.recordLimitReached).toBe(true);
    expect(result.recordCount).toBe(2);
    expect(parseNumstatEntriesZ(result.stdout)).toHaveLength(2);
    expect(parseNumstatEntriesZ(result.stdout)).toContainEqual({
      path: "RENAMED.md",
      insertions: 1,
      deletions: 0,
    });
  });

  it("does not confuse a regular numstat path ending in a tab with a rename", async () => {
    const repoPath = await initReadGitBlobRepo();
    const unusualPath = "trailing-tab\t";
    await fs.writeFile(path.join(repoPath, unusualPath), "one\n");
    await runGit(["add", unusualPath], { cwd: repoPath });

    const result = await runGitWithNullRecordLimit(
      ["diff", "--cached", "--numstat", "-z", "HEAD"],
      { cwd: repoPath },
      "numstat",
      1,
    );

    expect(result.recordLimitReached).toBe(true);
    expect(result.recordCount).toBe(1);
    expect(parseNumstatEntriesZ(result.stdout)).toEqual([
      { path: unusualPath, insertions: 1, deletions: 0 },
    ]);
  });
});

describe("detectGitRepoKind", () => {
  it("tells a bare repository root apart from its worktrees and plain directories", async () => {
    const { root, worktreePath } = await initBareWorktreeLayout();
    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-plain-dir-"));
    tempDirs.push(plainDir);

    await expect(detectGitRepoKind(root)).resolves.toBe("bare");
    await expect(detectGitRepoKind(path.join(root, ".bare"))).resolves.toBe(
      "bare",
    );
    await expect(detectGitRepoKind(worktreePath)).resolves.toBe("work-tree");
    await expect(detectGitRepoKind(plainDir)).resolves.toBe("none");
  });

  it("keeps detectGitRepo scoped to work trees so bare roots get no checkout UI", async () => {
    const { root, worktreePath } = await initBareWorktreeLayout();

    await expect(detectGitRepo(root)).resolves.toBe(false);
    await expect(detectGitRepo(worktreePath)).resolves.toBe(true);
  });
});

describe("readGitRepositoryState", () => {
  it("treats a bare repository root as a repository with commits", async () => {
    const { root } = await initBareWorktreeLayout();

    await expect(readGitRepositoryState(root)).resolves.toBe("has_commits");
  });
});

describe("getCheckoutRef", () => {
  it("reports the HEAD branch of a bare repository root", async () => {
    const { root } = await initBareWorktreeLayout();
    const head = await runGit(["rev-parse", "HEAD"], { cwd: root });

    await expect(getCheckoutRef(root)).resolves.toEqual({
      kind: "branch",
      branchName: "main",
      headSha: head.stdout.trim(),
    });
  });

  it("reports branch checkouts with HEAD sha", async () => {
    const repoPath = await initReadGitBlobRepo();
    const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });

    await expect(getCheckoutRef(repoPath)).resolves.toEqual({
      kind: "branch",
      branchName: "main",
      headSha: head.stdout.trim(),
    });
  });

  it("reports detached HEAD without pretending there is a current branch", async () => {
    const repoPath = await initReadGitBlobRepo();
    const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
    await runGit(["switch", "--detach", "HEAD"], { cwd: repoPath });

    await expect(getCheckoutRef(repoPath)).resolves.toEqual({
      kind: "detached",
      headSha: head.stdout.trim(),
    });
  });

  it("reports unborn branches for empty repositories", async () => {
    const repoPath = await initEmptyRepo();

    await expect(getCheckoutRef(repoPath)).resolves.toEqual({
      kind: "unborn",
      branchName: "main",
    });
  });
});

describe("readDefaultBranchRefs", () => {
  it("reports equal local and origin defaults", async () => {
    const { repoPath } = await initDefaultBranchRemoteRepo();

    await expect(readDefaultBranchRefs(repoPath)).resolves.toEqual({
      defaultBranch: "main",
      defaultBranchRelation: "equal",
      originDefaultBranch: "origin/main",
    });
  });

  it("reports a local default behind origin", async () => {
    const { remotePath, repoPath } = await initDefaultBranchRemoteRepo();
    await pushRemoteMainCommit(remotePath);
    await runGit(["fetch", "origin"], { cwd: repoPath });

    await expect(readDefaultBranchRefs(repoPath)).resolves.toMatchObject({
      defaultBranch: "main",
      defaultBranchRelation: "local-behind",
      originDefaultBranch: "origin/main",
    });
  });

  it("reports a local default ahead of origin", async () => {
    const { repoPath } = await initDefaultBranchRemoteRepo();
    await fs.writeFile(path.join(repoPath, "local.txt"), "local\n", "utf8");
    await runGit(["add", "."], { cwd: repoPath });
    await runGit(["commit", "-m", "Local edit"], { cwd: repoPath });

    await expect(readDefaultBranchRefs(repoPath)).resolves.toMatchObject({
      defaultBranch: "main",
      defaultBranchRelation: "local-ahead",
      originDefaultBranch: "origin/main",
    });
  });

  it("reports diverged local and origin defaults", async () => {
    const { remotePath, repoPath } = await initDefaultBranchRemoteRepo();
    await fs.writeFile(path.join(repoPath, "local.txt"), "local\n", "utf8");
    await runGit(["add", "."], { cwd: repoPath });
    await runGit(["commit", "-m", "Local edit"], { cwd: repoPath });
    await pushRemoteMainCommit(remotePath);
    await runGit(["fetch", "origin"], { cwd: repoPath });

    await expect(readDefaultBranchRefs(repoPath)).resolves.toMatchObject({
      defaultBranch: "main",
      defaultBranchRelation: "diverged",
      originDefaultBranch: "origin/main",
    });
  });

  it("omits origin defaults when no origin ref exists", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(readDefaultBranchRefs(repoPath)).resolves.toEqual({
      defaultBranch: "main",
      defaultBranchRelation: undefined,
      originDefaultBranch: undefined,
    });
  });
});

describe("getWorkspaceGitOperation", () => {
  it("reports no operation for ordinary repositories", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(getWorkspaceGitOperation(repoPath)).resolves.toEqual({
      kind: "none",
    });
  });

  it("reports merge conflicts", async () => {
    const repoPath = await initConflictRepo();
    const merge = await runGit(["merge", "feature"], {
      cwd: repoPath,
      allowFailure: true,
    });
    expect(merge.exitCode).not.toBe(0);

    await expect(getWorkspaceGitOperation(repoPath)).resolves.toEqual({
      kind: "merge",
      hasConflicts: true,
    });
  });

  it("reports rebase conflicts", async () => {
    const repoPath = await initConflictRepo();
    await runGit(["switch", "feature"], { cwd: repoPath });
    const rebase = await runGit(["rebase", "main"], {
      cwd: repoPath,
      allowFailure: true,
    });
    expect(rebase.exitCode).not.toBe(0);

    await expect(getWorkspaceGitOperation(repoPath)).resolves.toEqual({
      kind: "rebase",
      hasConflicts: true,
    });
  });
});

describe("command timeouts", () => {
  it("classifies git command timeouts as hard failures when allowFailure is true", async () => {
    const repoPath = await initEmptyRepo();

    await expect(
      runGit(["-c", "alias.bb-sleep=!sleep 5", "bb-sleep"], {
        cwd: repoPath,
        allowFailure: true,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({
      code: "git_command_timeout",
      name: "WorkspaceError",
    });
  });

  it("classifies shell pipeline timeouts as hard failures when allowFailure is true", async () => {
    const repoPath = await initEmptyRepo();

    await expect(
      runShellPipeline("sleep 5", [], {
        cwd: repoPath,
        allowFailure: true,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({
      code: "shell_pipeline_timeout",
      name: "WorkspaceError",
    });
  });
});

describe("user-shell Git resolution", () => {
  it("uses the resolved shell PATH for Git commands and Git pipelines", async () => {
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "bb-git-shell-path-workspace-"),
    );
    const binPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "bb-git-shell-path-bin-"),
    );
    tempDirs.push(workspacePath, binPath);
    const gitPath = path.join(binPath, "git");
    await fs.writeFile(gitPath, "#!/bin/sh\nprintf 'user-shell-git\\n'\n");
    await fs.chmod(gitPath, 0o755);

    await expect(
      runGit(["--version"], { cwd: workspacePath, shellPath: binPath }),
    ).resolves.toMatchObject({ stdout: "user-shell-git\n" });
    await expect(
      runShellPipeline("git --version", [], {
        cwd: workspacePath,
        shellPath: binPath,
      }),
    ).resolves.toMatchObject({ stdout: "user-shell-git\n" });
  });
});

describe("readGitBlob", () => {
  it("reads a blob at a git ref and reports the returned byte size", async () => {
    const repoPath = await initReadGitBlobRepo();

    const blob = await readGitBlob(repoPath, "HEAD", "README.md", 1024);

    expect(blob.contents?.toString("utf8")).toBe("hello\n");
    expect(blob.sizeBytes).toBe(Buffer.byteLength("hello\n"));
  });

  it("returns null contents for a missing blob path", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "HEAD", "missing.txt", 1024),
    ).resolves.toEqual({
      contents: null,
      sizeBytes: 0,
    });
  });

  it("returns null contents for a missing ref", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "missing-ref", "README.md", 1024),
    ).resolves.toEqual({
      contents: null,
      sizeBytes: 0,
    });
  });

  it("rejects non-blob git objects instead of treating them as missing", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "HEAD", "docs", 1024),
    ).rejects.toMatchObject({
      code: "git_command_failed",
    });
  });

  it("allows blobs exactly at the byte cap", async () => {
    const repoPath = await initReadGitBlobRepo();

    const blob = await readGitBlob(repoPath, "HEAD", "large.txt", 11);

    expect(blob.contents?.toString("utf8")).toBe("0123456789\n");
    expect(blob.sizeBytes).toBe(11);
  });

  it("rejects oversized blobs during size preflight", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "HEAD", "large.txt", 4),
    ).rejects.toMatchObject({
      code: "blob_too_large",
      message: "Blob size 11 bytes exceeds the 0 MB limit",
    });
  });
});

describe("parsePorcelainEntries", () => {
  it("parses ordinary entries and renamed targets", () => {
    expect(
      parsePorcelainEntries(
        [
          " M README.md",
          "R  old-name.ts -> new-name.ts",
          "D  removed.txt",
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "README.md",
        status: "M",
        indexStatus: " ",
        worktreeStatus: "M",
      },
      {
        path: "new-name.ts",
        status: "R",
        indexStatus: "R",
        worktreeStatus: " ",
      },
      {
        path: "removed.txt",
        status: "D",
        indexStatus: "D",
        worktreeStatus: " ",
      },
    ]);
  });

  it("decodes quoted git paths and octal escapes", () => {
    expect(
      parsePorcelainEntries(
        [
          '?? "a b.txt"',
          '?? "quote\\\\and\\\"slash.txt"',
          'R  "old\\040name.txt" -> "new\\040name.txt"',
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "a b.txt",
        status: "??",
        indexStatus: "?",
        worktreeStatus: "?",
      },
      {
        path: 'quote\\and"slash.txt',
        status: "??",
        indexStatus: "?",
        worktreeStatus: "?",
      },
      {
        path: "new name.txt",
        status: "R",
        indexStatus: "R",
        worktreeStatus: " ",
      },
    ]);
  });
});

describe("parseNameStatusEntries", () => {
  it("parses add, modify, and delete entries", () => {
    const output = [
      "A",
      "src/new.ts",
      "M",
      "src/existing.ts",
      "D",
      "src/old.ts",
      "",
    ].join("\0");
    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/new.ts", status: "A" },
      { path: "src/existing.ts", status: "M" },
      { path: "src/old.ts", status: "D" },
    ]);
  });

  it("takes the new path for rename and copy entries", () => {
    const output = [
      "R100",
      "src/old.ts",
      "src/new.ts",
      "C75",
      "src/base.ts",
      "src/copy.ts",
      "",
    ].join("\0");
    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/new.ts", status: "R" },
      { path: "src/copy.ts", status: "C" },
    ]);
  });

  it("preserves single-letter status with no similarity score", () => {
    const output = ["T", "src/link.ts", ""].join("\0");
    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/link.ts", status: "T" },
    ]);
  });

  it("interleaves regular and rename entries correctly", () => {
    const output = [
      "M",
      "src/a.ts",
      "R090",
      "src/b-old.ts",
      "src/b-new.ts",
      "A",
      "src/c.ts",
      "",
    ].join("\0");
    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "src/b-new.ts", status: "R" },
      { path: "src/c.ts", status: "A" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseNameStatusEntries("")).toEqual([]);
  });

  it("skips truncated trailing entries without throwing", () => {
    expect(parseNameStatusEntries("M\0")).toEqual([]);
    expect(parseNameStatusEntries("R100\0src/old.ts\0")).toEqual([]);
  });
});

describe("summarizeNumstat", () => {
  it("totals changed files, insertions, and deletions", () => {
    expect(
      summarizeNumstat(
        ["10\t4\tREADME.md", "-\t-\tbinary.dat", "2\t0\tsrc/app.ts"].join("\n"),
      ),
    ).toEqual({
      changedFiles: 3,
      insertions: 12,
      deletions: 4,
    });
  });
});

describe("parseNumstatEntriesZ", () => {
  it("parses normal and binary entries from NUL-delimited output", () => {
    const output =
      "10\t4\tREADME.md\0" + "-\t-\tbinary.dat\0" + "2\t0\tsrc/app.ts\0";
    expect(parseNumstatEntriesZ(output)).toEqual([
      { path: "README.md", insertions: 10, deletions: 4 },
      { path: "binary.dat", insertions: null, deletions: null },
      { path: "src/app.ts", insertions: 2, deletions: 0 },
    ]);
  });

  it("takes the new path for rename entries", () => {
    const output = "3\t1\t\0src/old.ts\0src/new.ts\0" + "5\t2\tsrc/app.ts\0";
    expect(parseNumstatEntriesZ(output)).toEqual([
      { path: "src/new.ts", insertions: 3, deletions: 1 },
      { path: "src/app.ts", insertions: 5, deletions: 2 },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseNumstatEntriesZ("")).toEqual([]);
  });
});

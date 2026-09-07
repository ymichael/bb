import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shellSingleQuote } from "@bb/test-helpers";
import { provisionWorkspace, type HostWorkspace } from "@bb/host-workspace";
import { dispatchOnlineRpcCommand } from "../../src/command-dispatch.js";
import {
  cleanupTempDirs,
  createHarness,
  makeTempDir,
  runGitCommand,
} from "./dispatch-helpers.js";

afterEach(cleanupTempDirs);

async function initBranchRepo(): Promise<string> {
  const repoPath = await makeTempDir("bb-host-branches-repo-");
  await runGitCommand(["init", "-b", "develop"], { cwd: repoPath });
  await runGitCommand(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGitCommand(["config", "user.email", "bb@example.com"], {
    cwd: repoPath,
  });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGitCommand(["add", "."], { cwd: repoPath });
  await runGitCommand(["commit", "-m", "Initial commit"], { cwd: repoPath });
  await runGitCommand(["branch", "main"], { cwd: repoPath });
  await runGitCommand(["branch", "release/1.2"], { cwd: repoPath });
  return repoPath;
}

interface StaleOriginMainRepo {
  releaseRefreshPath: string;
  refreshStartedPath: string;
  repoPath: string;
}

async function initStaleOriginMainRepo(): Promise<StaleOriginMainRepo> {
  const repoPath = await initBranchRepo();
  const remotePath = await makeTempDir("bb-host-branches-stale-remote-");
  await runGitCommand(["init", "--bare"], { cwd: remotePath });
  await runGitCommand(["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: remotePath,
  });
  await runGitCommand(["remote", "add", "origin", remotePath], {
    cwd: repoPath,
  });
  await runGitCommand(["push", "origin", "main"], { cwd: repoPath });
  await runGitCommand(["fetch", "origin"], { cwd: repoPath });
  await runGitCommand(["remote", "set-head", "origin", "main"], {
    cwd: repoPath,
  });

  const cloneParent = await makeTempDir("bb-host-branches-stale-clone-");
  const clonePath = path.join(cloneParent, "repo");
  await runGitCommand(["clone", remotePath, clonePath], { cwd: cloneParent });
  await runGitCommand(["config", "user.name", "BB Tests"], {
    cwd: clonePath,
  });
  await runGitCommand(["config", "user.email", "bb@example.com"], {
    cwd: clonePath,
  });
  await fs.writeFile(path.join(clonePath, "remote.txt"), "remote\n", "utf8");
  await runGitCommand(["add", "."], { cwd: clonePath });
  await runGitCommand(["commit", "-m", "Advance remote main"], {
    cwd: clonePath,
  });
  await runGitCommand(["push", "origin", "main"], { cwd: clonePath });

  const refreshStartedPath = path.join(repoPath, "refresh-started");
  const releaseRefreshPath = path.join(repoPath, "release-refresh");
  const uploadPackPath = path.join(repoPath, "delayed-upload-pack.sh");
  await fs.writeFile(
    uploadPackPath,
    `#!/bin/sh\ntouch ${JSON.stringify(refreshStartedPath)}\nwhile [ ! -f ${JSON.stringify(releaseRefreshPath)} ]; do sleep 0.01; done\nsleep 0.2\nexec git-upload-pack "$@"\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  await runGitCommand(["config", "remote.origin.uploadpack", uploadPackPath], {
    cwd: repoPath,
  });
  return { releaseRefreshPath, refreshStartedPath, repoPath };
}

async function expectResolvesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`Promise did not resolve within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function expectRemainsPending(
  promise: Promise<unknown>,
  timeoutMs = 100,
): Promise<void> {
  const state = await Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), timeoutMs);
    }),
  ]);
  expect(state).toBe("pending");
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`File did not appear within 2000ms: ${filePath}`);
}

describe("host.inspect_git_source dispatch", () => {
  it("reports checkout and default-ref metadata without branch pages", async () => {
    const repoPath = await initBranchRepo();
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.inspect_git_source",
        path: repoPath,
        remoteRefresh: "blocking",
      },
      harness.dispatchOptions(),
    );

    expect(result).toMatchObject({
      checkout: { kind: "branch", branchName: "develop" },
      defaultBranch: "main",
      defaultBranchRelation: null,
      hasUncommittedChanges: false,
      operation: { kind: "none" },
      originDefaultBranch: null,
    });
  });

  it("returns cached metadata while refreshing remotes in the background", async () => {
    const { releaseRefreshPath, refreshStartedPath, repoPath } =
      await initStaleOriginMainRepo();
    const harness = createHarness();
    let refreshedResult: Awaited<ReturnType<typeof dispatchOnlineRpcCommand>>;

    try {
      const result = await expectResolvesWithin(
        dispatchOnlineRpcCommand(
          {
            type: "host.inspect_git_source",
            path: repoPath,
            remoteRefresh: "background",
          },
          harness.dispatchOptions(),
        ),
        2_000,
      );
      expect(result).toMatchObject({
        defaultBranch: "main",
        defaultBranchRelation: "equal",
        originDefaultBranch: "origin/main",
      });
      await waitForFile(refreshStartedPath);
    } finally {
      await fs.writeFile(releaseRefreshPath, "release\n", "utf8");
      refreshedResult = await dispatchOnlineRpcCommand(
        {
          type: "host.inspect_git_source",
          path: repoPath,
          remoteRefresh: "blocking",
        },
        harness.dispatchOptions(),
      );
    }

    expect(refreshedResult).toMatchObject({
      defaultBranch: "main",
      defaultBranchRelation: "local-behind",
      originDefaultBranch: "origin/main",
    });
  });

  it("waits for a blocking refresh before reading default-ref metadata", async () => {
    const { releaseRefreshPath, refreshStartedPath, repoPath } =
      await initStaleOriginMainRepo();
    const harness = createHarness();
    const resultPromise = dispatchOnlineRpcCommand(
      {
        type: "host.inspect_git_source",
        path: repoPath,
        remoteRefresh: "blocking",
      },
      harness.dispatchOptions(),
    );
    let result: Awaited<typeof resultPromise>;

    try {
      await waitForFile(refreshStartedPath);
      await expectRemainsPending(resultPromise);
    } finally {
      await fs.writeFile(releaseRefreshPath, "release\n", "utf8");
      result = await resultPromise;
    }

    expect(result).toMatchObject({
      defaultBranch: "main",
      defaultBranchRelation: "local-behind",
      originDefaultBranch: "origin/main",
    });
  });

  it("reports detached HEAD in checkout state", async () => {
    const repoPath = await initBranchRepo();
    await runGitCommand(["switch", "--detach", "HEAD"], { cwd: repoPath });
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.inspect_git_source",
        path: repoPath,
        remoteRefresh: "blocking",
      },
      harness.dispatchOptions(),
    );

    expect(result.checkout.kind).toBe("detached");
  });

  it("reports dirty primary checkouts", async () => {
    const repoPath = await initBranchRepo();
    await fs.writeFile(path.join(repoPath, "draft.txt"), "dirty\n", "utf8");
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.inspect_git_source",
        path: repoPath,
        remoteRefresh: "blocking",
      },
      harness.dispatchOptions(),
    );

    expect(result.hasUncommittedChanges).toBe(true);
    expect(result.operation).toEqual({ kind: "none" });
  });

  it("inspects a bare repository root that holds sibling worktrees", async () => {
    const origin = await initBranchRepo();
    const root = await makeTempDir("bb-host-branches-bare-root-");
    await runGitCommand(["clone", "--bare", origin, ".bare"], { cwd: root });
    await fs.writeFile(path.join(root, ".git"), "gitdir: ./.bare\n", "utf8");
    await runGitCommand(["worktree", "add", "main", "main"], { cwd: root });
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.inspect_git_source",
        path: root,
        remoteRefresh: "blocking",
      },
      harness.dispatchOptions(),
    );

    expect(result.checkout).toMatchObject({
      kind: "branch",
      branchName: "develop",
    });
    expect(result.defaultBranch).toBe("main");
    expect(result.hasUncommittedChanges).toBe(false);
    expect(result.operation).toEqual({ kind: "none" });
  });

  it("reports non-git directories", async () => {
    const dirPath = await makeTempDir("bb-host-branches-nongit-");
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.inspect_git_source",
        path: dirPath,
        remoteRefresh: "blocking",
      },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({
      checkout: { kind: "unknown", reason: "Path is not a git repository" },
      defaultBranch: null,
      defaultBranchRelation: null,
      hasUncommittedChanges: false,
      operation: { kind: "none" },
      originDefaultBranch: null,
    });
  });

  it("reports missing paths", async () => {
    const parentPath = await makeTempDir("bb-host-branches-missing-parent-");
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.inspect_git_source",
        path: path.join(parentPath, "missing"),
        remoteRefresh: "blocking",
      },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({
      checkout: { kind: "unknown", reason: "Path is not a git repository" },
      defaultBranch: null,
      defaultBranchRelation: null,
      hasUncommittedChanges: false,
      operation: { kind: "none" },
      originDefaultBranch: null,
    });
  });

  it.runIf(process.platform !== "win32")(
    "serializes branch refresh and provisioning fetches for one repository",
    async () => {
      const repoPath = await initBranchRepo();
      const remotePath = await makeTempDir("bb-host-branches-lock-remote-");
      await runGitCommand(["init", "--bare"], { cwd: remotePath });
      await runGitCommand(["remote", "add", "origin", remotePath], {
        cwd: repoPath,
      });
      await runGitCommand(["push", "origin", "develop", "main"], {
        cwd: repoPath,
      });
      await runGitCommand(["fetch", "origin"], { cwd: repoPath });

      const refreshStartedPath = path.join(repoPath, "refresh-started");
      const releaseRefreshPath = path.join(repoPath, "release-refresh");
      const uploadPackPath = path.join(repoPath, "delayed-upload-pack.sh");
      await fs.writeFile(
        uploadPackPath,
        `#!/bin/sh\ntouch ${JSON.stringify(refreshStartedPath)}\nwhile [ ! -f ${JSON.stringify(releaseRefreshPath)} ]; do sleep 0.01; done\nexec git-upload-pack "$@"\n`,
        { encoding: "utf8", mode: 0o755 },
      );
      await runGitCommand(
        ["config", "remote.origin.uploadpack", uploadPackPath],
        { cwd: repoPath },
      );

      const binPath = await makeTempDir("bb-host-branches-lock-bin-");
      const commonDirMarker = path.join(binPath, "common-dir-resolved");
      const targetedFetchMarker = path.join(binPath, "targeted-fetch");
      const gitWrapperPath = path.join(binPath, "git");
      const systemPath = process.env.PATH ?? "";
      await fs.writeFile(
        gitWrapperPath,
        [
          "#!/bin/sh",
          "set -u",
          `system_path=${shellSingleQuote(systemPath)}`,
          `common_dir_marker=${shellSingleQuote(commonDirMarker)}`,
          `targeted_fetch_marker=${shellSingleQuote(targetedFetchMarker)}`,
          'if [ "$#" -eq 2 ] && [ "$1" = "rev-parse" ] && [ "$2" = "--git-common-dir" ]; then',
          '  PATH="$system_path" git "$@"',
          "  status=$?",
          '  touch "$common_dir_marker"',
          '  exit "$status"',
          "fi",
          'if [ "$#" -eq 4 ] && [ "$1" = "fetch" ] && [ "$2" = "--quiet" ] && [ "$3" = "origin" ] && [ "$4" = "+refs/heads/main:refs/remotes/origin/main" ]; then',
          '  touch "$targeted_fetch_marker"',
          "fi",
          'PATH="$system_path" exec git "$@"',
        ].join("\n") + "\n",
        { encoding: "utf8", mode: 0o755 },
      );

      const harness = createHarness();
      const sourceInspection = dispatchOnlineRpcCommand(
        {
          type: "host.inspect_git_source",
          path: repoPath,
          remoteRefresh: "blocking",
        },
        harness.dispatchOptions(),
      );
      let provisioning: Promise<HostWorkspace> | undefined;
      try {
        await waitForFile(refreshStartedPath);
        const targetParent = await makeTempDir(
          "bb-host-branches-lock-worktree-",
        );
        const targetPath = path.join(targetParent, "coordinated");
        provisioning = provisionWorkspace({
          workspaceProvisionType: "managed-worktree",
          sourcePath: repoPath,
          targetPath,
          branchName: "bb/coordinated",
          baseBranch: "origin/main",
          timeoutMs: 900_000,
          shellPath: `${binPath}${path.delimiter}${systemPath}`,
        });

        await waitForFile(commonDirMarker);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await expect(fs.access(targetedFetchMarker)).rejects.toThrow();

        await fs.writeFile(releaseRefreshPath, "release\n", "utf8");
        await sourceInspection;
        const workspace = await provisioning;
        expect(workspace.path).toBe(targetPath);
        await expect(fs.access(targetedFetchMarker)).resolves.toBeUndefined();
      } finally {
        await fs.writeFile(releaseRefreshPath, "release\n", "utf8");
        await Promise.allSettled([sourceInspection]);
        const provisionResult = await Promise.allSettled(
          provisioning ? [provisioning] : [],
        );
        const workspace = provisionResult[0];
        if (workspace?.status === "fulfilled") {
          await workspace.value.destroy({ timeoutMs: 900_000 });
        }
      }
    },
  );
});

describe("host.list_branch_options dispatch", () => {
  it("preserves complete local branch ordering", async () => {
    const repoPath = await initBranchRepo();
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.list_branch_options",
        path: repoPath,
        limit: 50,
        remoteRefresh: "none",
      },
      harness.dispatchOptions(),
    );

    expect(result.branches).toEqual(["main", "develop", "release/1.2"]);
    expect(result.branchesTruncated).toBe(false);
  });

  it("lists multiple branches from a non-origin remote in stable order", async () => {
    const repoPath = await initBranchRepo();
    const remotePath = await makeTempDir("bb-host-branch-options-upstream-");
    await runGitCommand(["init", "--bare"], { cwd: remotePath });
    await runGitCommand(["remote", "add", "upstream", remotePath], {
      cwd: repoPath,
    });
    await runGitCommand(["push", "upstream", "develop", "main"], {
      cwd: repoPath,
    });
    await runGitCommand(["fetch", "upstream"], { cwd: repoPath });
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.list_branch_options",
        path: repoPath,
        limit: 50,
        remoteRefresh: "none",
      },
      harness.dispatchOptions(),
    );

    expect(result.remoteBranches).toEqual([
      "upstream/develop",
      "upstream/main",
    ]);
    expect(result.remoteBranchesTruncated).toBe(false);
  });

  it("computes truncation after query filtering", async () => {
    const repoPath = await initBranchRepo();
    await runGitCommand(["branch", "release/2.0"], { cwd: repoPath });
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.list_branch_options",
        path: repoPath,
        query: "release",
        limit: 1,
        remoteRefresh: "none",
      },
      harness.dispatchOptions(),
    );

    expect(result.branches).toEqual(["release/1.2"]);
    expect(result.branchesTruncated).toBe(true);
    expect(result.remoteBranchesTruncated).toBe(false);
  });

  it("pins local and remote defaults before applying the page limit", async () => {
    const repoPath = await initBranchRepo();
    const remotePath = await makeTempDir("bb-host-branch-options-origin-");
    await runGitCommand(["init", "--bare"], { cwd: remotePath });
    await runGitCommand(["remote", "add", "origin", remotePath], {
      cwd: repoPath,
    });
    await runGitCommand(["branch", "bb/aardvark"], { cwd: repoPath });
    await runGitCommand(["push", "origin", "bb/aardvark", "main"], {
      cwd: repoPath,
    });
    await runGitCommand(["fetch", "origin"], { cwd: repoPath });
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.list_branch_options",
        path: repoPath,
        limit: 1,
        remoteRefresh: "none",
      },
      harness.dispatchOptions(),
    );

    expect(result.branches).toEqual(["main"]);
    expect(result.branchesTruncated).toBe(true);
    expect(result.remoteBranches).toEqual(["origin/main"]);
    expect(result.remoteBranchesTruncated).toBe(true);
  });

  it("returns cached refs while a remote refresh continues in the background", async () => {
    const repoPath = await initBranchRepo();
    const remotePath = await makeTempDir("bb-host-branch-options-remote-");
    await runGitCommand(["init", "--bare"], { cwd: remotePath });
    await runGitCommand(["remote", "add", "origin", remotePath], {
      cwd: repoPath,
    });
    await runGitCommand(["push", "origin", "main"], { cwd: repoPath });
    await runGitCommand(["fetch", "origin"], { cwd: repoPath });

    const cloneParent = await makeTempDir("bb-host-branch-options-clone-");
    const clonePath = path.join(cloneParent, "repo");
    await runGitCommand(["clone", remotePath, clonePath], { cwd: cloneParent });
    await runGitCommand(["config", "user.name", "BB Tests"], {
      cwd: clonePath,
    });
    await runGitCommand(["config", "user.email", "bb@example.com"], {
      cwd: clonePath,
    });
    await runGitCommand(["switch", "-c", "feature/remote-only"], {
      cwd: clonePath,
    });
    await fs.writeFile(path.join(clonePath, "remote.txt"), "remote\n", "utf8");
    await runGitCommand(["add", "."], { cwd: clonePath });
    await runGitCommand(["commit", "-m", "Remote branch"], { cwd: clonePath });
    await runGitCommand(["push", "origin", "feature/remote-only"], {
      cwd: clonePath,
    });

    const refreshStartedPath = path.join(repoPath, "refresh-started");
    const releaseRefreshPath = path.join(repoPath, "release-refresh");
    const uploadPackPath = path.join(repoPath, "delayed-upload-pack.sh");
    await fs.writeFile(
      uploadPackPath,
      `#!/bin/sh\ntouch ${JSON.stringify(refreshStartedPath)}\nwhile [ ! -f ${JSON.stringify(releaseRefreshPath)} ]; do sleep 0.01; done\nexec git-upload-pack "$@"\n`,
      { encoding: "utf8", mode: 0o755 },
    );
    await runGitCommand(
      ["config", "remote.origin.uploadpack", uploadPackPath],
      {
        cwd: repoPath,
      },
    );
    const harness = createHarness();

    const resultPromise = dispatchOnlineRpcCommand(
      {
        type: "host.list_branch_options",
        path: repoPath,
        query: "remote-only",
        selectedBranch: "origin/feature/remote-only",
        limit: 50,
        remoteRefresh: "background",
      },
      harness.dispatchOptions(),
    );

    try {
      const result = await expectResolvesWithin(resultPromise, 2_000);
      expect(result).toEqual({
        branches: [],
        branchesTruncated: false,
        remoteBranches: [],
        remoteBranchesTruncated: false,
        selectedBranch: {
          kind: "missing",
          name: "origin/feature/remote-only",
        },
      });
      await waitForFile(refreshStartedPath);
    } finally {
      await fs.writeFile(releaseRefreshPath, "release\n", "utf8");
      await dispatchOnlineRpcCommand(
        {
          type: "host.inspect_git_source",
          path: repoPath,
          remoteRefresh: "blocking",
        },
        harness.dispatchOptions(),
      );
    }

    const refreshed = await dispatchOnlineRpcCommand(
      {
        type: "host.list_branch_options",
        path: repoPath,
        query: "remote-only",
        limit: 50,
        remoteRefresh: "none",
      },
      harness.dispatchOptions(),
    );
    expect(refreshed.remoteBranches).toContain("origin/feature/remote-only");
  });

  it("classifies selected refs before filtering and pagination", async () => {
    const repoPath = await initBranchRepo();
    const remotePath = await makeTempDir("bb-host-branch-options-upstream-");
    await runGitCommand(["init", "--bare"], { cwd: remotePath });
    await runGitCommand(["remote", "add", "upstream", remotePath], {
      cwd: repoPath,
    });
    await runGitCommand(["push", "upstream", "develop", "main"], {
      cwd: repoPath,
    });
    await runGitCommand(["fetch", "upstream"], { cwd: repoPath });
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.list_branch_options",
        path: repoPath,
        query: "release",
        selectedBranch: "upstream/main",
        limit: 1,
        remoteRefresh: "none",
      },
      harness.dispatchOptions(),
    );

    expect(result.branches).toEqual(["release/1.2"]);
    expect(result.remoteBranches).toEqual([]);
    expect(result.selectedBranch).toEqual({
      name: "upstream/main",
      kind: "remote",
    });
  });

  it("lists cached branches from bare project sources", async () => {
    const origin = await initBranchRepo();
    const root = await makeTempDir("bb-host-branch-options-bare-root-");
    await runGitCommand(["clone", "--bare", origin, ".bare"], { cwd: root });
    await fs.writeFile(path.join(root, ".git"), "gitdir: ./.bare\n", "utf8");
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.list_branch_options",
        path: root,
        limit: 50,
        remoteRefresh: "none",
      },
      harness.dispatchOptions(),
    );

    expect(result.branches).toEqual(
      expect.arrayContaining(["main", "develop", "release/1.2"]),
    );
  });

  it("returns empty pages for non-git and missing paths", async () => {
    const dirPath = await makeTempDir("bb-host-branch-options-nongit-");
    const harness = createHarness();

    for (const sourcePath of [dirPath, path.join(dirPath, "missing")]) {
      const result = await dispatchOnlineRpcCommand(
        {
          type: "host.list_branch_options",
          path: sourcePath,
          selectedBranch: "main",
          limit: 50,
          remoteRefresh: "none",
        },
        harness.dispatchOptions(),
      );

      expect(result).toEqual({
        branches: [],
        branchesTruncated: false,
        remoteBranches: [],
        remoteBranchesTruncated: false,
        selectedBranch: { kind: "missing", name: "main" },
      });
    }
  });

  it("does not start a remote refresh when the caller opts out", async () => {
    const repoPath = await initBranchRepo();
    const harness = createHarness();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "host.list_branch_options",
        path: repoPath,
        selectedBranch: "main",
        limit: 1,
        remoteRefresh: "none",
      },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({
      branches: ["main"],
      branchesTruncated: true,
      remoteBranches: [],
      remoteBranchesTruncated: false,
      selectedBranch: { kind: "local", name: "main" },
    });
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ENV_SETUP_SCRIPT_NAME,
  DEFAULT_ENV_TEARDOWN_SCRIPT_NAME,
  type ProvisioningTranscriptEntry,
} from "@bb/domain";
import {
  createDeferredPromise,
  shellSingleQuote,
  waitForSetupMarkerCount,
} from "@bb/test-helpers";
import { Workspace } from "../src/workspace.js";
import {
  buildSetupScriptCommand,
  createWorktree,
  fetchRemoteBaseBranch,
  removeWorktree,
  runSetupScript,
  runTeardownScript,
} from "../src/provisioning.js";
import { getGitCommonDir, runGit } from "../src/git.js";
import { withGitRefMutationLock } from "../src/git-ref-mutation-lock.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initRepoWithOptionalSetup(
  setupScript?: string,
): Promise<string> {
  const repoPath = await makeTempDir("bb-provisioning-repo-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  if (setupScript) {
    await fs.writeFile(
      path.join(repoPath, DEFAULT_ENV_SETUP_SCRIPT_NAME),
      setupScript,
      "utf8",
    );
  }
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  return repoPath;
}

async function initRemoteBackedRepo(): Promise<{
  remotePath: string;
  repoPath: string;
}> {
  const repoPath = await initRepoWithOptionalSetup();
  const remotePath = await makeTempDir("bb-provisioning-remote-");
  await runGit(["init", "--bare"], { cwd: remotePath });
  await runGit(["remote", "add", "origin", remotePath], { cwd: repoPath });
  await runGit(["push", "-u", "origin", "main"], { cwd: repoPath });
  await runGit(["fetch", "origin"], { cwd: repoPath });
  return { remotePath, repoPath };
}

async function commitTeardownScript(
  repoPath: string,
  script: string,
): Promise<void> {
  await fs.writeFile(
    path.join(repoPath, DEFAULT_ENV_TEARDOWN_SCRIPT_NAME),
    script,
    "utf8",
  );
  await runGit(["add", DEFAULT_ENV_TEARDOWN_SCRIPT_NAME], { cwd: repoPath });
  await runGit(["commit", "-m", "Add teardown script"], { cwd: repoPath });
}

async function pushRemoteMainCommit(remotePath: string): Promise<string> {
  const cloneParent = await makeTempDir("bb-provisioning-remote-clone-");
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
  const head = await runGit(["rev-parse", "HEAD"], { cwd: clonePath });
  await runGit(["push", "origin", "main"], { cwd: clonePath });
  return head.stdout.trim();
}

class AbortAtSetupListenerSignal extends EventTarget implements AbortSignal {
  onabort: ((this: AbortSignal, event: Event) => void) | null = null;
  readonly reason = new Error("test abort");
  private abortedReadCount = 0;

  get aborted(): boolean {
    this.abortedReadCount += 1;
    return this.abortedReadCount >= 3;
  }

  throwIfAborted(): void {
    if (this.aborted) {
      throw this.reason;
    }
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace provisioning", () => {
  it("explains all requirements when a worktree source is not a repository", async () => {
    const sourceDir = await makeTempDir("bb-provisioning-non-git-source-");
    const parentDir = await makeTempDir("bb-worktree-non-git-parent-");
    const targetPath = path.join(parentDir, "feature");

    await expect(
      createWorktree({
        sourcePath: sourceDir,
        targetPath,
        branchName: "feature",
        baseBranch: null,
        timeoutMs: 900000,
      }),
    ).rejects.toMatchObject({
      name: "WorkspaceError",
      code: "not_git_repo",
      message:
        `Cannot create a worktree because the source is not a Git repository: ${sourceDir}. ` +
        "Initialize it and create at least one commit, then try again.",
    });
    await expect(fs.stat(targetPath)).rejects.toThrow();
  });

  it("rejects a commitless repository with an actionable error", async () => {
    const sourceRepo = await makeTempDir("bb-provisioning-empty-repo-");
    await runGit(["init", "-b", "main"], { cwd: sourceRepo });
    const parentDir = await makeTempDir("bb-worktree-empty-parent-");
    const targetPath = path.join(parentDir, "feature");

    await expect(
      createWorktree({
        sourcePath: sourceRepo,
        targetPath,
        branchName: "feature",
        baseBranch: null,
        timeoutMs: 900000,
      }),
    ).rejects.toMatchObject({
      name: "WorkspaceError",
      code: "unborn_head",
      message:
        `Cannot create a worktree because the repository has no commits: ${sourceRepo}. ` +
        "Create an initial commit, then try again.",
    });
    await expect(fs.stat(targetPath)).rejects.toThrow();
  });

  it("creates worktrees and is idempotent for valid targets", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    const parentDir = await makeTempDir("bb-worktree-parent-");
    const targetPath = path.join(parentDir, "feature");

    const first = await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature",
      baseBranch: "main",
      timeoutMs: 900000,
    });
    const second = await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature",
      baseBranch: "main",
      timeoutMs: 900000,
    });

    expect(first.path).toBe(targetPath);
    expect(second.path).toBe(targetPath);
    expect(await new Workspace(targetPath).currentBranch).toBe("feature");
  });

  it("creates worktrees from a bare repository root that holds sibling worktrees", async () => {
    const origin = await initRepoWithOptionalSetup();
    const root = await makeTempDir("bb-worktree-bare-root-");
    await runGit(["clone", "--bare", origin, ".bare"], { cwd: root });
    await fs.writeFile(path.join(root, ".git"), "gitdir: ./.bare\n", "utf8");
    await runGit(["worktree", "add", "existing", "-b", "existing"], {
      cwd: root,
    });
    const parentDir = await makeTempDir("bb-worktree-bare-parent-");
    const targetPath = path.join(parentDir, "feature");

    await expect(
      createWorktree({
        sourcePath: root,
        targetPath,
        branchName: "feature",
        baseBranch: null,
        timeoutMs: 900000,
      }),
    ).resolves.toEqual({ path: targetPath });

    expect(await new Workspace(targetPath).currentBranch).toBe("feature");
    const worktrees = await runGit(["worktree", "list", "--porcelain"], {
      cwd: root,
    });
    expect(worktrees.stdout.split("\n")).toContain(
      `worktree ${await fs.realpath(targetPath)}`,
    );
  });

  it("fetches remote base branches before creating worktrees", async () => {
    const { remotePath, repoPath } = await initRemoteBackedRepo();
    const parentDir = await makeTempDir("bb-worktree-remote-parent-");
    const targetPath = path.join(parentDir, "feature");
    const remoteHead = await pushRemoteMainCommit(remotePath);

    const staleOriginMain = await runGit(["rev-parse", "origin/main"], {
      cwd: repoPath,
    });
    expect(staleOriginMain.stdout.trim()).not.toBe(remoteHead);

    await createWorktree({
      sourcePath: repoPath,
      targetPath,
      branchName: "feature",
      baseBranch: "origin/main",
      timeoutMs: 900000,
    });

    await expect(
      fs.readFile(path.join(targetPath, "remote.txt"), "utf8"),
    ).resolves.toBe("remote\n");
    const worktreeHead = await runGit(["rev-parse", "HEAD"], {
      cwd: targetPath,
    });
    expect(worktreeHead.stdout.trim()).toBe(remoteHead);
  });

  it.runIf(process.platform !== "win32")(
    "recovers from known concurrent remote-ref update failures",
    async () => {
      const failures = [
        "error: cannot lock ref 'refs/remotes/origin/main': is at 2222222222222222222222222222222222222222 but expected 1111111111111111111111111111111111111111",
        "error: cannot lock ref 'refs/remotes/origin/main': Unable to create '/repo/.git/refs/remotes/origin/main.lock': File exists.",
        "error: fetching ref refs/remotes/origin/main failed: reference already exists",
      ];

      for (const failure of failures) {
        const { remotePath, repoPath } = await initRemoteBackedRepo();
        const parentDir = await makeTempDir("bb-worktree-fetch-race-parent-");
        const binPath = await makeTempDir("bb-worktree-fetch-race-bin-");
        const failedFetchMarker = path.join(binPath, "failed-fetch");
        const fetchLocaleMarker = path.join(binPath, "fetch-locale");
        const gitWrapperPath = path.join(binPath, "git");
        const targetPath = path.join(parentDir, "feature");
        const remoteHead = await pushRemoteMainCommit(remotePath);
        const systemPath = process.env.PATH ?? "";
        await fs.writeFile(
          gitWrapperPath,
          [
            "#!/bin/sh",
            "set -eu",
            `system_path=${shellSingleQuote(systemPath)}`,
            `failed_fetch_marker=${shellSingleQuote(failedFetchMarker)}`,
            `fetch_locale_marker=${shellSingleQuote(fetchLocaleMarker)}`,
            'if [ "$#" -eq 4 ] && [ "$1" = "fetch" ] && [ "$2" = "--quiet" ] && [ "$3" = "origin" ] && [ "$4" = "+refs/heads/main:refs/remotes/origin/main" ] && [ ! -f "$failed_fetch_marker" ]; then',
            '  touch "$failed_fetch_marker"',
            '  printf "%s" "${LC_ALL:-}" > "$fetch_locale_marker"',
            '  if [ "${LC_ALL:-}" = "C" ]; then',
            `    echo ${shellSingleQuote(failure)} >&2`,
            "  else",
            "    echo \"Fehler: Referenz 'refs/remotes/origin/main' kann nicht gesperrt werden\" >&2",
            "  fi",
            "  exit 1",
            "fi",
            'PATH="$system_path" exec git "$@"',
          ].join("\n") + "\n",
          "utf8",
        );
        await fs.chmod(gitWrapperPath, 0o755);

        await expect(
          createWorktree({
            sourcePath: repoPath,
            targetPath,
            branchName: "feature",
            baseBranch: "origin/main",
            timeoutMs: 900000,
            shellPath: `${binPath}${path.delimiter}${systemPath}`,
          }),
        ).resolves.toEqual({ path: targetPath });
        await expect(fs.stat(failedFetchMarker)).resolves.toBeDefined();
        await expect(fs.readFile(fetchLocaleMarker, "utf8")).resolves.toBe("C");
        await expect(
          fs.readFile(path.join(targetPath, "remote.txt"), "utf8"),
        ).resolves.toBe("remote\n");
        const worktreeHead = await runGit(["rev-parse", "HEAD"], {
          cwd: targetPath,
        });
        expect(worktreeHead.stdout.trim()).toBe(remoteHead);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "waits for a live remote-ref lock before retrying the fetch",
    async () => {
      const { remotePath, repoPath } = await initRemoteBackedRepo();
      const parentDir = await makeTempDir("bb-worktree-live-ref-lock-parent-");
      const binPath = await makeTempDir("bb-worktree-live-ref-lock-bin-");
      const firstFetchFailedMarker = path.join(
        binPath,
        "started-first-fetch-failed",
      );
      const gitWrapperPath = path.join(binPath, "git");
      const targetPath = path.join(parentDir, "feature");
      const remoteHead = await pushRemoteMainCommit(remotePath);
      const commonDir = await getGitCommonDir(repoPath);
      const remoteRefLockPath = path.join(
        commonDir,
        "refs",
        "remotes",
        "origin",
        "main.lock",
      );
      await fs.mkdir(path.dirname(remoteRefLockPath), { recursive: true });
      await fs.writeFile(remoteRefLockPath, "held\n", "utf8");
      const systemPath = process.env.PATH ?? "";
      await fs.writeFile(
        gitWrapperPath,
        [
          "#!/bin/sh",
          "set -eu",
          `system_path=${shellSingleQuote(systemPath)}`,
          `first_fetch_failed=${shellSingleQuote(firstFetchFailedMarker)}`,
          'if [ "$#" -eq 4 ] && [ "$1" = "fetch" ] && [ "$2" = "--quiet" ] && [ "$3" = "origin" ] && [ "$4" = "+refs/heads/main:refs/remotes/origin/main" ]; then',
          "  set +e",
          '  PATH="$system_path" git "$@"',
          "  status=$?",
          "  set -e",
          '  if [ "$status" -ne 0 ]; then touch "$first_fetch_failed"; fi',
          '  exit "$status"',
          "fi",
          'PATH="$system_path" exec git "$@"',
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.chmod(gitWrapperPath, 0o755);

      const provisioning = createWorktree({
        sourcePath: repoPath,
        targetPath,
        branchName: "feature",
        baseBranch: "origin/main",
        timeoutMs: 900000,
        shellPath: `${binPath}${path.delimiter}${systemPath}`,
      });
      const settledProvisioning = provisioning.then(
        (result) => result,
        (error: unknown) => error,
      );
      try {
        await waitForSetupMarkerCount({
          expectedCount: 1,
          markerDir: binPath,
          timeoutMs: 2_000,
        });
        await fs.rm(remoteRefLockPath);
        await expect(settledProvisioning).resolves.toEqual({
          path: targetPath,
        });
        const worktreeHead = await runGit(["rev-parse", "HEAD"], {
          cwd: targetPath,
        });
        expect(worktreeHead.stdout.trim()).toBe(remoteHead);
      } finally {
        await fs.rm(remoteRefLockPath, { force: true });
        await Promise.allSettled([provisioning]);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "releases the ref lock after a targeted fetch times out",
    async () => {
      const { repoPath } = await initRemoteBackedRepo();
      const uploadPackStartedPath = path.join(repoPath, "started-upload-pack");
      const releaseUploadPackPath = path.join(repoPath, "release-upload-pack");
      const uploadPackPath = path.join(repoPath, "stalled-upload-pack.sh");
      await fs.writeFile(
        uploadPackPath,
        `#!/bin/sh\ntouch ${JSON.stringify(uploadPackStartedPath)}\nwhile [ ! -f ${JSON.stringify(releaseUploadPackPath)} ]; do sleep 0.01; done\nexec git-upload-pack "$@"\n`,
        { encoding: "utf8", mode: 0o755 },
      );
      await runGit(["config", "remote.origin.uploadpack", uploadPackPath], {
        cwd: repoPath,
      });
      const commonDir = await getGitCommonDir(repoPath);
      const stalledFetch = fetchRemoteBaseBranch({
        sourcePath: repoPath,
        baseBranch: "origin/main",
        fetchTimeoutMs: 250,
        onProgress: undefined,
        shellPath: undefined,
        signal: undefined,
      });
      const stalledFetchError = stalledFetch.then(
        () => null,
        (error: unknown) => error,
      );

      try {
        await waitForSetupMarkerCount({
          expectedCount: 1,
          markerDir: repoPath,
          timeoutMs: 2_000,
        });
        const nextMutation = withGitRefMutationLock(
          commonDir,
          async () => undefined,
          { timeoutMs: 2_000 },
        );
        await expect(stalledFetchError).resolves.toMatchObject({
          code: "git_command_timeout",
        });
        await expect(nextMutation).resolves.toBeUndefined();
      } finally {
        await fs.writeFile(releaseUploadPackPath, "release\n", "utf8");
        await Promise.allSettled([stalledFetch]);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "records a failed fetch when resolving the common Git directory fails",
    async () => {
      const { repoPath } = await initRemoteBackedRepo();
      const parentDir = await makeTempDir("bb-worktree-common-dir-parent-");
      const binPath = await makeTempDir("bb-worktree-common-dir-bin-");
      const gitWrapperPath = path.join(binPath, "git");
      const targetPath = path.join(parentDir, "feature");
      const systemPath = process.env.PATH ?? "";
      await fs.writeFile(
        gitWrapperPath,
        [
          "#!/bin/sh",
          "set -eu",
          `system_path=${shellSingleQuote(systemPath)}`,
          'if [ "$#" -eq 2 ] && [ "$1" = "rev-parse" ] && [ "$2" = "--git-common-dir" ]; then',
          '  echo "common dir unavailable" >&2',
          "  exit 1",
          "fi",
          'PATH="$system_path" exec git "$@"',
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.chmod(gitWrapperPath, 0o755);
      const transcript: ProvisioningTranscriptEntry[] = [];

      await expect(
        createWorktree({
          sourcePath: repoPath,
          targetPath,
          branchName: "feature",
          baseBranch: "origin/main",
          timeoutMs: 900000,
          shellPath: `${binPath}${path.delimiter}${systemPath}`,
          onProgress: (entry) => transcript.push(entry),
        }),
      ).rejects.toMatchObject({ code: "git_command_failed" });
      expect(
        transcript.some(
          (entry) =>
            entry.type === "step" &&
            entry.key === "git-fetch-failed" &&
            entry.status === "failed",
        ),
      ).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "cancels while resolving the common Git directory",
    async () => {
      const { repoPath } = await initRemoteBackedRepo();
      const parentDir = await makeTempDir(
        "bb-worktree-common-dir-abort-parent-",
      );
      const binPath = await makeTempDir("bb-worktree-common-dir-abort-bin-");
      const commonDirStartedPath = path.join(binPath, "started-common-dir");
      const releaseCommonDirPath = path.join(binPath, "release-common-dir");
      const gitWrapperPath = path.join(binPath, "git");
      const targetPath = path.join(parentDir, "feature");
      const systemPath = process.env.PATH ?? "";
      await fs.writeFile(
        gitWrapperPath,
        [
          "#!/bin/sh",
          "set -eu",
          `system_path=${shellSingleQuote(systemPath)}`,
          `common_dir_started=${shellSingleQuote(commonDirStartedPath)}`,
          `release_common_dir=${shellSingleQuote(releaseCommonDirPath)}`,
          'if [ "$#" -eq 2 ] && [ "$1" = "rev-parse" ] && [ "$2" = "--git-common-dir" ]; then',
          '  touch "$common_dir_started"',
          '  while [ ! -f "$release_common_dir" ]; do sleep 0.01; done',
          "fi",
          'PATH="$system_path" exec git "$@"',
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.chmod(gitWrapperPath, 0o755);
      const abortController = new AbortController();
      const transcript: ProvisioningTranscriptEntry[] = [];
      const provisioning = createWorktree({
        sourcePath: repoPath,
        targetPath,
        branchName: "feature",
        baseBranch: "origin/main",
        timeoutMs: 900000,
        shellPath: `${binPath}${path.delimiter}${systemPath}`,
        signal: abortController.signal,
        onProgress: (entry) => transcript.push(entry),
      });
      let cancellationTimeout: ReturnType<typeof setTimeout> | undefined;

      try {
        await waitForSetupMarkerCount({
          expectedCount: 1,
          markerDir: binPath,
          timeoutMs: 2_000,
        });
        abortController.abort(new Error("test abort"));
        await expect(
          Promise.race([
            provisioning,
            new Promise<never>((_, reject) => {
              cancellationTimeout = setTimeout(
                () =>
                  reject(
                    new Error(
                      "Provisioning did not cancel while resolving the common Git directory",
                    ),
                  ),
                2_000,
              );
            }),
          ]),
        ).rejects.toMatchObject({ code: "provision_cancelled" });
        expect(
          transcript.some(
            (entry) =>
              entry.type === "step" &&
              entry.key === "git-fetch-failed" &&
              entry.status === "failed",
          ),
        ).toBe(true);
      } finally {
        if (cancellationTimeout !== undefined) {
          clearTimeout(cancellationTimeout);
        }
        await fs.writeFile(releaseCommonDirPath, "release\n", "utf8");
        await Promise.allSettled([provisioning]);
      }
    },
  );

  it("keeps cancellation typed while waiting for a coordinated remote fetch", async () => {
    const { repoPath } = await initRemoteBackedRepo();
    const parentDir = await makeTempDir("bb-worktree-fetch-abort-parent-");
    const targetPath = path.join(parentDir, "feature");
    const abortController = new AbortController();
    const commonDir = await getGitCommonDir(repoPath);
    const lockEntered = createDeferredPromise<void>();
    const releaseLock = createDeferredPromise<void>();
    const lockHolder = withGitRefMutationLock(commonDir, async () => {
      lockEntered.resolve();
      await releaseLock.promise;
    });
    await lockEntered.promise;
    const fetchStarted = createDeferredPromise<void>();
    const transcript: ProvisioningTranscriptEntry[] = [];

    const provisioning = createWorktree({
      sourcePath: repoPath,
      targetPath,
      branchName: "feature",
      baseBranch: "origin/main",
      timeoutMs: 900000,
      signal: abortController.signal,
      onProgress: (entry) => {
        transcript.push(entry);
        if (entry.key === "git-fetch-started") {
          fetchStarted.resolve();
        }
      },
    });

    try {
      await fetchStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 100));
      abortController.abort(new Error("test abort"));
      await expect(provisioning).rejects.toMatchObject({
        code: "provision_cancelled",
      });
      expect(
        transcript.some(
          (entry) =>
            entry.type === "step" &&
            entry.key === "git-fetch-failed" &&
            entry.status === "failed",
        ),
      ).toBe(true);
    } finally {
      releaseLock.resolve();
      await lockHolder;
    }
  });

  it("rolls back failed worktree setup scripts", async () => {
    const sourceRepo = await initRepoWithOptionalSetup(
      "echo failing >&2\nexit 1\n",
    );
    const parentDir = await makeTempDir("bb-worktree-fail-parent-");
    const targetPath = path.join(parentDir, "broken");

    await expect(
      createWorktree({
        sourcePath: sourceRepo,
        targetPath,
        branchName: "broken",
        baseBranch: "main",
        timeoutMs: 900000,
      }),
    ).rejects.toThrow(/Setup script failed/u);

    await expect(fs.stat(targetPath)).rejects.toThrow();
  });

  it("runs worktree setup scripts concurrently after creating worktrees", async () => {
    const coordinationDir = await makeTempDir("bb-worktree-setup-concurrency-");
    const markerDir = path.join(coordinationDir, "markers");
    const releaseFile = path.join(coordinationDir, "release");
    const sourceRepo = await initRepoWithOptionalSetup(
      [
        "set -euo pipefail",
        `marker_dir=${shellSingleQuote(markerDir)}`,
        `release_file=${shellSingleQuote(releaseFile)}`,
        'marker_name="$(basename "$(dirname "$PWD")")-$(basename "$PWD")"',
        'mkdir -p "$marker_dir"',
        'touch "$marker_dir/started-$marker_name"',
        'while [ ! -f "$release_file" ]; do sleep 0.05; done',
        "echo setup released",
      ].join("\n") + "\n",
    );
    const parentDir = await makeTempDir("bb-worktree-concurrent-parent-");
    const firstTargetPath = path.join(parentDir, "feature-a");
    const secondTargetPath = path.join(parentDir, "feature-b");

    const provisions = Promise.all([
      createWorktree({
        sourcePath: sourceRepo,
        targetPath: firstTargetPath,
        branchName: "feature-a",
        baseBranch: "main",
        timeoutMs: 900000,
      }),
      createWorktree({
        sourcePath: sourceRepo,
        targetPath: secondTargetPath,
        branchName: "feature-b",
        baseBranch: "main",
        timeoutMs: 900000,
      }),
    ]);
    void provisions.catch(() => undefined);

    try {
      await expect(
        waitForSetupMarkerCount({
          markerDir,
          expectedCount: 2,
          timeoutMs: 10000,
        }),
      ).resolves.toHaveLength(2);
    } finally {
      await fs.writeFile(releaseFile, "release\n", "utf8");
    }

    await expect(provisions).resolves.toEqual([
      { path: firstTargetPath },
      { path: secondTargetPath },
    ]);
  }, 15000);

  it("creates nested worktree targets when parent directories do not exist", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    const parentDir = await makeTempDir("bb-worktree-nested-parent-");
    const targetPath = path.join(
      parentDir,
      ".bb-worktrees",
      "proj_123",
      "thr_456",
    );

    await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature",
      baseBranch: "main",
      timeoutMs: 900000,
    });

    expect(await new Workspace(targetPath).currentBranch).toBe("feature");
  });

  it("passes explicit env overrides to git commands", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();

    const result = await runGit(["var", "GIT_AUTHOR_IDENT"], {
      cwd: sourceRepo,
      env: {
        GIT_AUTHOR_EMAIL: "env@example.com",
        GIT_AUTHOR_NAME: "Env Author",
      },
    });

    expect(result.stdout).toContain("Env Author <env@example.com>");
  });

  it("streams setup script output and respects timeouts", async () => {
    const workspacePath = await makeTempDir("bb-setup-script-");
    await fs.writeFile(
      path.join(workspacePath, DEFAULT_ENV_SETUP_SCRIPT_NAME),
      "echo first\necho second\n",
      "utf8",
    );

    const entries: string[] = [];
    const result = await runSetupScript({
      workspacePath,
      timeoutMs: 900000,
      onProgress: (entry) => entries.push(`${entry.type}:${entry.text}`),
    });
    expect(result.ran).toBe(true);
    expect(result.output).toContain("first");
    expect(entries.some((entry) => entry.includes("first"))).toBe(true);

    await fs.writeFile(
      path.join(workspacePath, DEFAULT_ENV_SETUP_SCRIPT_NAME),
      "sleep 2\n",
      "utf8",
    );
    await expect(
      runSetupScript({
        workspacePath,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/u);
  });

  it("aborts setup scripts and emits cancellation progress", async () => {
    const workspacePath = await makeTempDir("bb-setup-abort-");
    const markerDir = await makeTempDir("bb-setup-abort-markers-");
    await fs.writeFile(
      path.join(workspacePath, DEFAULT_ENV_SETUP_SCRIPT_NAME),
      [
        "set -euo pipefail",
        `marker_dir=${shellSingleQuote(markerDir)}`,
        'trap "touch \\"$marker_dir/started-terminated\\"; exit 0" TERM',
        'touch "$marker_dir/started-setup"',
        "while true; do sleep 0.05; done",
      ].join("\n") + "\n",
      "utf8",
    );
    const abortController = new AbortController();
    const entries: string[] = [];
    const run = runSetupScript({
      workspacePath,
      timeoutMs: 900000,
      signal: abortController.signal,
      onProgress: (entry) => entries.push(`${entry.key}:${entry.text}`),
    });

    await waitForSetupMarkerCount({
      expectedCount: 1,
      markerDir,
      timeoutMs: 2_000,
    });
    abortController.abort(new Error("test abort"));

    await expect(run).rejects.toMatchObject({ code: "provision_cancelled" });
    await waitForSetupMarkerCount({
      expectedCount: 2,
      markerDir,
      timeoutMs: 2_000,
    });
    expect(entries).toContain("setup-cancelled:.bb-env-setup.sh cancelled");
  });

  it("aborts setup scripts when the signal is aborted at listener registration", async () => {
    const workspacePath = await makeTempDir("bb-setup-listener-abort-");
    const markerDir = await makeTempDir("bb-setup-listener-abort-markers-");
    const completedMarker = path.join(markerDir, "completed-setup");
    await fs.writeFile(
      path.join(workspacePath, DEFAULT_ENV_SETUP_SCRIPT_NAME),
      [
        "set -euo pipefail",
        `marker_dir=${shellSingleQuote(markerDir)}`,
        'trap "exit 0" TERM',
        "sleep 0.2",
        'touch "$marker_dir/completed-setup"',
      ].join("\n") + "\n",
      "utf8",
    );
    const entries: string[] = [];

    await expect(
      runSetupScript({
        workspacePath,
        timeoutMs: 900000,
        signal: new AbortAtSetupListenerSignal(),
        onProgress: (entry) => entries.push(`${entry.key}:${entry.text}`),
      }),
    ).rejects.toMatchObject({ code: "provision_cancelled" });

    await expect(fs.stat(completedMarker)).rejects.toThrow();
    expect(entries).toContain("setup-cancelled:.bb-env-setup.sh cancelled");
  });

  it("removes managed worktrees after setup script cancellation", async () => {
    const markerDir = await makeTempDir("bb-worktree-abort-markers-");
    const sourceRepo = await initRepoWithOptionalSetup(
      [
        "set -euo pipefail",
        `marker_dir=${shellSingleQuote(markerDir)}`,
        'trap "touch \\"$marker_dir/started-terminated\\"; exit 0" TERM',
        'touch "$marker_dir/started-setup"',
        "while true; do sleep 0.05; done",
      ].join("\n") + "\n",
    );
    const parentDir = await makeTempDir("bb-worktree-abort-parent-");
    const targetPath = path.join(parentDir, "cancelled");
    const abortController = new AbortController();
    const provision = createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "cancelled",
      baseBranch: "main",
      timeoutMs: 900000,
      signal: abortController.signal,
    });

    await waitForSetupMarkerCount({
      expectedCount: 1,
      markerDir,
      timeoutMs: 2_000,
    });
    abortController.abort(new Error("test abort"));

    await expect(provision).rejects.toMatchObject({
      code: "provision_cancelled",
    });
    await waitForSetupMarkerCount({
      expectedCount: 2,
      markerDir,
      timeoutMs: 2_000,
    });
    await expect(fs.stat(targetPath)).rejects.toThrow();
    const worktrees = await runGit(["worktree", "list", "--porcelain"], {
      cwd: sourceRepo,
    });
    expect(worktrees.stdout).not.toContain(targetPath);
  });

  it("compacts carriage-return setup script progress in transcript output", async () => {
    const workspacePath = await makeTempDir("bb-setup-progress-");
    await fs.writeFile(
      path.join(workspacePath, DEFAULT_ENV_SETUP_SCRIPT_NAME),
      "printf 'progress 1\\rprogress 2\\rprogress done\\n'\n",
      "utf8",
    );

    const outputEntries: string[] = [];
    const result = await runSetupScript({
      workspacePath,
      timeoutMs: 900000,
      onProgress: (entry) => {
        if (entry.type === "output" && entry.key.startsWith("setup-output-")) {
          outputEntries.push(entry.text);
        }
      },
    });

    expect(result.output).toBe("progress 1\rprogress 2\rprogress done\n");
    expect(outputEntries).toEqual(["progress done"]);
  });

  it("closes setup script stdin so hooks do not block on input", async () => {
    const workspacePath = await makeTempDir("bb-setup-stdin-closed-");
    await fs.writeFile(
      path.join(workspacePath, DEFAULT_ENV_SETUP_SCRIPT_NAME),
      "if read line; then echo unexpected-input; else echo stdin-closed; fi\n",
      "utf8",
    );

    const result = await runSetupScript({
      workspacePath,
      timeoutMs: 500,
    });

    expect(result.ran).toBe(true);
    expect(result.output).toContain("stdin-closed");
  });

  it("scrubs inherited bb runtime env vars before running setup scripts", async () => {
    vi.stubEnv("BB_DATA_DIR", "/tmp/leaked-bb-data");
    vi.stubEnv("BB_SERVER_PORT", "38886");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EXTERNAL_SETUP_ENV", "external-value");
    const workspacePath = await makeTempDir("bb-setup-env-");
    await fs.writeFile(
      path.join(workspacePath, DEFAULT_ENV_SETUP_SCRIPT_NAME),
      [
        'printf "%s|%s|%s|%s\\n" \\',
        '  "${BB_DATA_DIR-missing}" \\',
        '  "${BB_SERVER_PORT-missing}" \\',
        '  "${NODE_ENV-missing}" \\',
        '  "${EXTERNAL_SETUP_ENV-missing}"',
      ].join("\n"),
      "utf8",
    );

    const result = await runSetupScript({
      workspacePath,
      timeoutMs: 900000,
    });

    expect(result.ran).toBe(true);
    expect(result.output).toBe("missing|missing|missing|external-value\n");
  });

  it("uses the resolved user-shell PATH for setup scripts", async () => {
    const workspacePath = await makeTempDir("bb-setup-shell-path-");
    const binPath = await makeTempDir("bb-setup-shell-bin-");
    const executablePath = path.join(binPath, "shell-path-tool");
    await fs.writeFile(executablePath, "#!/bin/sh\necho resolved-shell-path\n");
    await fs.chmod(executablePath, 0o755);
    await fs.writeFile(
      path.join(workspacePath, DEFAULT_ENV_SETUP_SCRIPT_NAME),
      "shell-path-tool\n",
      "utf8",
    );

    const result = await runSetupScript({
      workspacePath,
      timeoutMs: 900000,
      shellPath: `${binPath}${path.delimiter}/usr/bin:/bin`,
    });

    expect(result.ran).toBe(true);
    expect(result.output).toBe("resolved-shell-path\n");
  });

  it("builds a bash command for the supported setup script", () => {
    expect(
      buildSetupScriptCommand({
        platform: "darwin",
        scriptPath: "/tmp/.bb-env-setup.sh",
      }),
    ).toMatchObject({
      command: "env",
      args: ["bash", "/tmp/.bb-env-setup.sh"],
      text: "env bash .bb-env-setup.sh",
    });
  });

  it("rejects POSIX shell setup scripts on Windows", () => {
    expect(() =>
      buildSetupScriptCommand({
        platform: "win32",
        scriptPath: "C:\\repo\\.bb-env-setup.sh",
      }),
    ).toThrow(/not supported on Windows/u);
  });

  it("returns a no-op when the setup script is missing", async () => {
    const workspacePath = await makeTempDir("bb-setup-noop-");

    await expect(
      runSetupScript({ workspacePath, timeoutMs: 900000 }),
    ).resolves.toEqual({ ran: false });
  });

  it("returns a no-op when the teardown script is missing", async () => {
    const workspacePath = await makeTempDir("bb-teardown-noop-");

    await expect(
      runTeardownScript({ workspacePath, timeoutMs: 900000 }),
    ).resolves.toEqual({ ran: false });
  });

  it("runs teardown scripts before it removes managed worktrees", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    const markerPath = path.join(
      await makeTempDir("bb-teardown-marker-"),
      "marker.txt",
    );
    await commitTeardownScript(
      sourceRepo,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$PWD" "$(cat README.md)" > ${shellSingleQuote(markerPath)}`,
        'echo "released external resource"',
      ].join("\n"),
    );
    const parentDir = await makeTempDir("bb-remove-teardown-parent-");
    const targetPath = path.join(parentDir, "feature");
    await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature-teardown",
      baseBranch: "main",
      timeoutMs: 900000,
    });
    const entries: string[] = [];

    await removeWorktree({
      path: targetPath,
      timeoutMs: 900000,
      force: true,
      onProgress: (entry) => entries.push(`${entry.key}:${entry.text}`),
    });

    expect(await fs.readFile(markerPath, "utf8")).toBe(
      `${targetPath}\nhello\n`,
    );
    expect(entries).toContain("teardown-started:Running .bb-env-teardown.sh");
    expect(entries).toContain("teardown-output-1:released external resource");
    expect(entries).toContain(
      "teardown-completed:.bb-env-teardown.sh finished",
    );
    await expect(fs.stat(targetPath)).rejects.toThrow();
  });

  it("reports teardown failures and removes the worktree", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    await commitTeardownScript(
      sourceRepo,
      ["#!/usr/bin/env bash", 'echo "cleanup failed"', "exit 7"].join("\n"),
    );
    const parentDir = await makeTempDir("bb-remove-failed-teardown-parent-");
    const targetPath = path.join(parentDir, "feature");
    await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature-failed-teardown",
      baseBranch: "main",
      timeoutMs: 900000,
    });
    const entries: string[] = [];

    await expect(
      removeWorktree({
        path: targetPath,
        timeoutMs: 900000,
        force: true,
        onProgress: (entry) => entries.push(`${entry.key}:${entry.text}`),
      }),
    ).resolves.toBeUndefined();

    expect(entries).toContain("teardown-output-1:cleanup failed");
    expect(entries).toContain("teardown-failed:.bb-env-teardown.sh failed");
    expect(entries.some((entry) => entry.includes("exit code 7"))).toBe(true);
    await expect(fs.stat(targetPath)).rejects.toThrow();
  });

  it("stops timed out teardown scripts and removes the worktree", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    await commitTeardownScript(
      sourceRepo,
      ["#!/usr/bin/env bash", 'echo "waiting"', "sleep 30"].join("\n"),
    );
    const parentDir = await makeTempDir("bb-remove-timeout-teardown-parent-");
    const targetPath = path.join(parentDir, "feature");
    await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature-timeout-teardown",
      baseBranch: "main",
      timeoutMs: 900000,
    });
    const entries: string[] = [];

    await expect(
      removeWorktree({
        path: targetPath,
        timeoutMs: 50,
        force: true,
        onProgress: (entry) => entries.push(`${entry.key}:${entry.text}`),
      }),
    ).resolves.toBeUndefined();

    expect(entries).toContain("teardown-output-1:waiting");
    expect(entries).toContain("teardown-failed:.bb-env-teardown.sh failed");
    expect(entries.some((entry) => entry.includes("timed out"))).toBe(true);
    await expect(fs.stat(targetPath)).rejects.toThrow();
  });

  it("removes worktrees and plain directories", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    const parentDir = await makeTempDir("bb-remove-parent-");
    const targetPath = path.join(parentDir, "feature");

    await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature",
      baseBranch: "main",
      timeoutMs: 900000,
    });
    await fs.writeFile(path.join(targetPath, "local.txt"), "dirty\n", "utf8");
    await removeWorktree({ path: targetPath, timeoutMs: 900000, force: true });
    await expect(fs.stat(targetPath)).rejects.toThrow();
    const worktrees = await runGit(["worktree", "list", "--porcelain"], {
      cwd: sourceRepo,
    });
    expect(worktrees.stdout).not.toContain(targetPath);
  });

  it("removes orphaned worktree directories after the .git file is gone", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    const parentDir = await makeTempDir("bb-remove-orphan-gitfile-");
    const targetPath = path.join(parentDir, "feature");

    await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature-orphan-gitfile",
      baseBranch: "main",
      timeoutMs: 900000,
    });
    await fs.rm(path.join(targetPath, ".git"), { force: true });

    await removeWorktree({ path: targetPath, timeoutMs: 900000, force: true });

    await expect(fs.stat(targetPath)).rejects.toThrow();
  });

  it("removes directories that no longer resolve as git repositories", async () => {
    const targetPath = await makeTempDir("bb-remove-non-git-dir-");
    await fs.writeFile(path.join(targetPath, "file.txt"), "data\n", "utf8");

    await removeWorktree({ path: targetPath, timeoutMs: 900000, force: true });

    await expect(fs.stat(targetPath)).rejects.toThrow();
  });

  it("removes worktree directories when git metadata cleanup fails", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    const parentDir = await makeTempDir("bb-remove-metadata-failure-");
    const targetPath = path.join(parentDir, "feature");

    await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature-metadata-failure",
      baseBranch: "main",
      timeoutMs: 900000,
    });
    await fs.writeFile(path.join(targetPath, "local.txt"), "dirty\n", "utf8");

    await removeWorktree({ path: targetPath, timeoutMs: 900000, force: false });

    await expect(fs.stat(targetPath)).rejects.toThrow();
  });
});
